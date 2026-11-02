import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "../../lib/tasks/vpn-download-types";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import {
  cancelVpnDownloadPlan,
  cancelVpnDownloadRange,
  createVpnDownloadPlan,
  getVpnDownloadRangeJobs,
  listVpnDownloadPlans,
  settleVpnDownloadChapter,
  updateVpnDownloadPlan,
} from "./vpn-download-plans";

let sqlite: DatabaseSync;
let directory: string;
let operations: Promise<unknown>;

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = operations.then(run);
  operations = result.catch(() => undefined);
  return result;
}

const rawDb = {
  select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(
    Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never,
  ),
  execute: async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(
      Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never,
    );
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  },
};

beforeEach(() => {
  mkdirSync(".tmp", { recursive: true });
  directory = mkdtempSync(".tmp/vpn-plan-storage-");
  sqlite = new DatabaseSync(join(directory, "norea.db"));
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(readFileSync("src-tauri/src/migrations/0002_vpn_download_plans.sql", "utf8"));
  sqlite.exec(readFileSync("src-tauri/src/migrations/0003_vpn_download_profile_issues.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES
    (42,'source','/work','Work',1), (99,'other-source','/other','Other work',1);
    INSERT INTO chapter(id,novel_id,path,name,position) VALUES
    (31,42,'/31','One',1), (7,42,'/7','Extra',2), (22,42,'/22','Three',3),
    (4,42,'/4','Four',4), (19,42,'/19','Extra',5), (12,42,'/12','Six',6),
    (90,99,'/90','Other',1)`);
  operations = Promise.resolve();
  vi.mocked(getDb).mockResolvedValue({
    select: (...args: Parameters<typeof rawDb.select>) => exclusive(() => rawDb.select(...args)),
    execute: (...args: Parameters<typeof rawDb.execute>) => exclusive(() => rawDb.execute(...args)),
  } as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(run => exclusive(async () => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = await run(rawDb as never);
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }));
});

afterEach(async () => {
  await operations;
  sqlite.close();
  rmSync(directory, { recursive: true });
});

function range(id: string, profileId: string, chapterIds: number[], selectedChapterIds: number[]): VpnDownloadRangeState {
  return {
    id, profileId, profileHash: "a".repeat(64), chapterIds, selectedChapterIds,
    startChapterId: chapterIds[0]!, endChapterId: chapterIds.at(-1)!,
    checkpoint: 0, phase: "paused", userPaused: false, pauseReason: null,
    attemptedProfileIds: [], attemptProfileId: null, generation: 2, challenge: null,
  };
}

function plan(): VpnDownloadPlan {
  return {
    id: "plan-1", batchId: "batch-1", pluginId: "source", novelId: 42, title: "Work", mode: "parallel",
    policies: { captcha: "nextProfile", cloudflare: "pause" }, createdAt: 100, revision: 0,
    ranges: [range("lane-a", "profile-a", [31, 7, 22], [31, 22]), range("lane-b", "profile-b", [4, 19, 12], [4, 12])],
  };
}

function jobs(value = plan()): ChapterDownloadJob[] {
  return value.ranges.flatMap(range => range.selectedChapterIds.slice(range.checkpoint).map(id => ({
    id, pluginId: value.pluginId, novelId: value.novelId, novelPath: value.novelId === 42 ? "/work" : "/other",
    chapterPath: `/${id}`, title: `Chapter ${id}`, batchId: value.batchId, vpnPlanId: value.id, vpnRangeId: range.id,
  })));
}

function exhaustedPlan(): VpnDownloadPlan {
  const value = plan();
  Object.assign(value.ranges[0]!, {
    checkpoint: 1, pauseReason: "profiles-exhausted", attemptedProfileIds: ["profile-a", "spare"],
    attemptProfileId: "spare", challenge: { kind: "cloudflare", url: "https://source.test/work" },
  });
  Object.assign(value.ranges[1]!, { phase: "running", attemptedProfileIds: ["profile-b"] });
  return value;
}

function restartedPlan(value: VpnDownloadPlan): VpnDownloadPlan {
  const next = structuredClone(value);
  Object.assign(next.ranges[0]!, { generation: next.ranges[0]!.generation + 1, attemptedProfileIds: [], attemptProfileId: null, pauseReason: null, userPaused: false });
  return next;
}

function queueRows() {
  return sqlite.prepare("SELECT * FROM chapter_download_queue ORDER BY chapter_id").all();
}

function enqueueOrdinary(id = 7) {
  sqlite.prepare("INSERT INTO chapter_download_queue VALUES(?,?,10,20,30,4)")
    .run(id, JSON.stringify({ id, pluginId: "source", chapterPath: `/${id}`, title: "Ordinary" }));
}

it("publishes the immutable plan and every enrolled job in one transaction with native queue defaults", async () => {
  enqueueOrdinary();
  const ordinary = queueRows();
  const value = plan();
  const before = Date.now();
  await createVpnDownloadPlan(value, jobs(value).reverse());
  expect(await listVpnDownloadPlans()).toEqual([value]);
  expect((await getVpnDownloadRangeJobs(value.id, "lane-a")).map(job => job.id)).toEqual([31, 22]);
  expect(queueRows().filter(row => row.chapter_id === 7)).toEqual(ordinary);
  for (const row of queueRows().filter(row => row.chapter_id !== 7)) {
    expect(row.created_at_ms).toBeGreaterThanOrEqual(before);
    expect(row.updated_at_ms).toBe(row.created_at_ms);
    expect(row.leased_at_ms).toBeNull();
    expect(row.attempt_count).toBe(0);
    expect(JSON.parse(String(row.job_json))).toMatchObject({ vpnPlanId: value.id });
  }
});

it("requires a stable batch identity and rejects jobs from another batch before publication", async () => {
  const value = Object.assign(plan(), { batchId: "batch-1" });
  const wrong = jobs(value).map(job => ({ ...job, batchId: "other-batch" }));
  await expect(createVpnDownloadPlan(value, wrong)).rejects.toThrow(/batch/i);
  expect(await listVpnDownloadPlans()).toEqual([]);
  expect(queueRows()).toEqual([]);
});

it("does not let a plan switch batches after publication", async () => {
  const value = Object.assign(plan(), { batchId: "batch-1" });
  await createVpnDownloadPlan(value, jobs(value).map(job => ({ ...job, batchId: value.batchId })));
  await expect(updateVpnDownloadPlan({ ...value, batchId: "other-batch" }, 0)).rejects.toThrow(/immutable|batch/i);
  expect(await listVpnDownloadPlans()).toEqual([value]);
});

it("persists an exact owner's batch failure without changing O/X, jobs or checkpoints and keeps it after plan deletion", async () => {
  const { listVpnDownloadProfileIssues, recordVpnDownloadProfileIssue } = await import("./vpn-download-profile-issues");
  const value = plan();
  await createVpnDownloadPlan(value, jobs(value));
  sqlite.exec("INSERT INTO vpn_gate_server_verdict(ip,verdict,updated_at) VALUES('192.0.2.1','works',10)");
  const queue = queueRows();
  const before = Date.now();
  const failure = await recordVpnDownloadProfileIssue({ batchId: value.batchId, planId: value.id, rangeId: "lane-a",
    generation: 2, profileId: "profile-a", profileHash: "a".repeat(64), ip: "192.0.2.1", cause: "captcha" });
  expect(failure).toMatchObject({ excluded: true, revision: 1, cause: "captcha", batchId: "batch-1" });
  expect(failure.recordedAt).toBeGreaterThanOrEqual(before);
  expect(queueRows()).toEqual(queue);
  expect(await listVpnDownloadPlans()).toEqual([value]);
  expect(sqlite.prepare("SELECT verdict,updated_at FROM vpn_gate_server_verdict").get()).toEqual({ verdict: "works", updated_at: 10 });
  sqlite.close(); sqlite = new DatabaseSync(join(directory, "norea.db"));
  expect(await listVpnDownloadProfileIssues("batch-1")).toEqual([failure]);
  expect(await listVpnDownloadProfileIssues("unrelated-batch")).toEqual([]);
  await cancelVpnDownloadPlan(value.id);
  expect(await listVpnDownloadProfileIssues()).toEqual([failure]);
});

it.each(["batch", "plan", "range", "profile", "hash", "generation"] as const)("rejects a stale or wrong %s failure without modifying history", async field => {
  const { listVpnDownloadProfileIssues, recordVpnDownloadProfileIssue } = await import("./vpn-download-profile-issues");
  await createVpnDownloadPlan(plan(), jobs());
  const failure = { batchId: "batch-1", planId: "plan-1", rangeId: "lane-a", generation: 2,
    profileId: "profile-a", profileHash: "a".repeat(64), ip: "192.0.2.1", cause: "captcha" as const };
  if (field === "batch") failure.batchId = "other";
  if (field === "plan") failure.planId = "other";
  if (field === "range") failure.rangeId = "other";
  if (field === "profile") failure.profileId = "other";
  if (field === "hash") failure.profileHash = "b".repeat(64);
  if (field === "generation") failure.generation = 1;
  await expect(recordVpnDownloadProfileIssue(failure)).rejects.toThrow(/owner|identity|generation|missing|stale/i);
  expect(await listVpnDownloadProfileIssues()).toEqual([]);
});

it("requires the current issue revision to reallow a batch and retains its reason", async () => {
  const { listVpnDownloadProfileIssues, recordVpnDownloadProfileIssue, reallowVpnDownloadProfile } = await import("./vpn-download-profile-issues");
  await createVpnDownloadPlan(plan(), jobs());
  const input = { batchId: "batch-1", planId: "plan-1", rangeId: "lane-a", generation: 2,
    profileId: "profile-a", profileHash: "a".repeat(64), ip: "192.0.2.1", cause: "captcha" as const };
  const first = await recordVpnDownloadProfileIssue(input);
  const allowed = await reallowVpnDownloadProfile(first.batchId, first.ip, first.revision);
  expect(allowed).toEqual({ ...first, excluded: false, revision: 2 });
  const failedAgain = await recordVpnDownloadProfileIssue({ ...input, cause: "cloudflare" });
  expect(failedAgain).toMatchObject({ cause: "cloudflare", excluded: true, revision: 3 });
  await expect(reallowVpnDownloadProfile(first.batchId, first.ip, allowed.revision)).rejects.toThrow(/stale|revision/i);
  expect(await listVpnDownloadProfileIssues()).toEqual([failedAgain]);
});

it.each(["ordinary", "range"])("rolls back publication on a late %s queue collision without stealing it", async owner => {
  enqueueOrdinary(12);
  if (owner === "range") {
    sqlite.prepare("UPDATE chapter_download_queue SET job_json=? WHERE chapter_id=12")
      .run(JSON.stringify({ ...jobs().at(-1), vpnPlanId: "existing-plan", vpnRangeId: "existing-range" }));
  }
  const original = queueRows();
  await expect(createVpnDownloadPlan(plan(), jobs())).rejects.toThrow(/queue|queued|UNIQUE/i);
  expect(await listVpnDownloadPlans()).toEqual([]);
  expect(queueRows()).toEqual(original);
});

it("rolls back earlier jobs and the plan when a later queue write fails", async () => {
  sqlite.exec("CREATE TRIGGER reject_job BEFORE INSERT ON chapter_download_queue WHEN new.chapter_id=12 BEGIN SELECT RAISE(ABORT,'injected disk write failure'); END");
  await expect(createVpnDownloadPlan(plan(), jobs())).rejects.toThrow("injected disk write failure");
  expect(await listVpnDownloadPlans()).toEqual([]);
  expect(queueRows()).toEqual([]);
});

it("retains exact membership, holes, checkpoints and recovery state across catalog reordering and reopen", async () => {
  await createVpnDownloadPlan(plan(), jobs());
  const settled = await settleVpnDownloadChapter("plan-1", "lane-a", 31, 2);
  settled.ranges[0] = {
    ...settled.ranges[0]!, phase: "running", userPaused: true, pauseReason: "manual",
    attemptedProfileIds: ["profile-a", "spare"], attemptProfileId: "spare",
    challenge: { kind: "captcha", url: "https://source.test/work" }, generation: 3,
  };
  const updated = await updateVpnDownloadPlan(settled, settled.revision);
  sqlite.exec("UPDATE chapter SET position=100-position WHERE novel_id=42; INSERT INTO chapter(id,novel_id,path,name,position) VALUES(100,42,'/new','New',2)");
  sqlite.close();
  sqlite = new DatabaseSync(join(directory, "norea.db"));
  expect(await listVpnDownloadPlans()).toEqual([updated]);
  expect((await getVpnDownloadRangeJobs("plan-1", "lane-a")).map(job => job.id)).toEqual([22]);
  expect((await getVpnDownloadRangeJobs("plan-1", "lane-b")).map(job => job.id)).toEqual([4, 12]);
});

it("uses revision compare-and-swap and never lets one stale lane overwrite another", async () => {
  await createVpnDownloadPlan(plan(), jobs());
  const first = plan();
  first.ranges[0]!.userPaused = true;
  const updated = await updateVpnDownloadPlan(first, 0);
  expect(updated.revision).toBe(1);
  expect(first.revision).toBe(0);
  const stale = plan();
  stale.ranges[1]!.userPaused = true;
  await expect(updateVpnDownloadPlan(stale, 0)).rejects.toThrow(/revision|stale/i);
  await expect(updateVpnDownloadPlan({ ...updated, id: "missing" }, 1)).rejects.toThrow(/missing|not found/i);
  expect(await listVpnDownloadPlans()).toEqual([updated]);
});

it("retains the one-pass recovery budget and challenge until full chapter settlement", async () => {
  const value = plan();
  value.ranges[0]!.attemptedProfileIds = ["profile-a", "spare"];
  value.ranges[0]!.challenge = { kind: "captcha", url: "https://source.test/work" };
  await createVpnDownloadPlan(value, jobs(value));
  const clearedAttempts = structuredClone(value);
  clearedAttempts.ranges[0]!.attemptedProfileIds = [];
  await expect(updateVpnDownloadPlan(clearedAttempts, 0)).rejects.toThrow(/recovery|attempt|settle/i);
  const clearedChallenge = structuredClone(value);
  clearedChallenge.ranges[0]!.challenge = null;
  await expect(updateVpnDownloadPlan(clearedChallenge, 0)).rejects.toThrow(/challenge|settle/i);
  expect(await listVpnDownloadPlans()).toEqual([value]);
  const changedChallenge = structuredClone(value);
  changedChallenge.ranges[0]!.challenge = { kind: "cloudflare", url: "https://source.test/work" };
  changedChallenge.ranges[0]!.attemptedProfileIds.push("second-spare");
  expect((await updateVpnDownloadPlan(changedChallenge, 0)).ranges[0]!.attemptedProfileIds)
    .toEqual(["profile-a", "spare", "second-spare"]);
});

it("explicitly restarts only a paused range's profile pass with current CAS and a newer generation, preserving challenge, jobs and siblings across reopen", async () => {
  const value = exhaustedPlan();
  await createVpnDownloadPlan(value, jobs(value));
  const queue = queueRows();
  const chapters = sqlite.prepare("SELECT * FROM chapter ORDER BY id").all();
  const next = restartedPlan(value);
  const restarted = await updateVpnDownloadPlan(next, 0, { restartPassRangeId: "lane-a" });
  expect(restarted.revision).toBe(1);
  expect(restarted.ranges[0]).toMatchObject({ checkpoint: 1, generation: 3, attemptedProfileIds: [], attemptProfileId: null, challenge: value.ranges[0]!.challenge });
  expect(restarted.ranges[1]).toEqual(value.ranges[1]);
  expect(queueRows()).toEqual(queue);
  expect(sqlite.prepare("SELECT * FROM chapter ORDER BY id").all()).toEqual(chapters);
  sqlite.close(); sqlite = new DatabaseSync(join(directory, "norea.db"));
  expect(await listVpnDownloadPlans()).toEqual([restarted]);
  expect((await getVpnDownloadRangeJobs("plan-1", "lane-a")).map(job => job.id)).toEqual([22]);
  await expect(settleVpnDownloadChapter("plan-1", "lane-a", 22, 2)).rejects.toThrow(/generation/i);
});

it.each([
  ["unchanged generation", (next: VpnDownloadPlan) => { next.ranges[0]!.generation = 2; }],
  ["older generation", (next: VpnDownloadPlan) => { next.ranges[0]!.generation = 1; }],
  ["connecting target", (next: VpnDownloadPlan) => { next.ranges[0]!.phase = "connecting"; }],
  ["running target", (next: VpnDownloadPlan) => { next.ranges[0]!.phase = "running"; }],
  ["cleared challenge", (next: VpnDownloadPlan) => { next.ranges[0]!.challenge = null; }],
  ["changed challenge", (next: VpnDownloadPlan) => { next.ranges[0]!.challenge = { kind: "captcha", url: "https://source.test/changed" }; }],
  ["changed checkpoint", (next: VpnDownloadPlan) => { next.ranges[0]!.checkpoint = 0; }],
  ["partial attempt reset", (next: VpnDownloadPlan) => { next.ranges[0]!.attemptedProfileIds = ["profile-a"]; }],
  ["retained in-flight attempt", (next: VpnDownloadPlan) => { next.ranges[0]!.attemptProfileId = "spare"; }],
  ["changed profile", (next: VpnDownloadPlan) => { next.ranges[0]!.profileId = "another"; }],
  ["changed sibling state", (next: VpnDownloadPlan) => { next.ranges[1]!.userPaused = true; }],
  ["cleared sibling attempts", (next: VpnDownloadPlan) => { next.ranges[1]!.attemptedProfileIds = []; }],
] as const)("rejects an explicit pass restart with %s", async (_label, mutate) => {
  const value = exhaustedPlan();
  await createVpnDownloadPlan(value, jobs(value));
  const queue = queueRows();
  const next = restartedPlan(value); mutate(next);
  await expect(updateVpnDownloadPlan(next, 0, { restartPassRangeId: "lane-a" })).rejects.toThrow();
  expect(await listVpnDownloadPlans()).toEqual([value]);
  expect(queueRows()).toEqual(queue);
});

it.each(["running", "connecting", "completed", "cancelled"] as const)("requires a persisted paused target before explicit restart, not %s", async phase => {
  const value = exhaustedPlan();
  value.ranges[0]!.phase = phase;
  if (phase === "completed") value.ranges[0]!.checkpoint = 2;
  await createVpnDownloadPlan(value, phase === "cancelled" ? jobs(value).filter(job => job.vpnRangeId !== "lane-a") : jobs(value));
  const next = restartedPlan(value); next.ranges[0]!.phase = "paused";
  await expect(updateVpnDownloadPlan(next, 0, { restartPassRangeId: "lane-a" })).rejects.toThrow(/paused|stopped/i);
  expect(await listVpnDownloadPlans()).toEqual([value]);
});

it("rejects a stale or unnamed recovery restart and never grants a reset to another range", async () => {
  const value = exhaustedPlan();
  await createVpnDownloadPlan(value, jobs(value));
  const next = restartedPlan(value);
  await expect(updateVpnDownloadPlan(next, 0)).rejects.toThrow(/recovery|attempt|settle/i);
  await expect(updateVpnDownloadPlan(next, 0, { restartPassRangeId: "missing" })).rejects.toThrow(/not found/i);
  await expect(updateVpnDownloadPlan(next, 0, { restartPassRangeId: "lane-b" })).rejects.toThrow();
  const newer = structuredClone(value); newer.ranges[1]!.pauseReason = "offline";
  const stored = await updateVpnDownloadPlan(newer, 0);
  await expect(updateVpnDownloadPlan(next, 0, { restartPassRangeId: "lane-a" })).rejects.toThrow(/revision|stale/i);
  expect(await listVpnDownloadPlans()).toEqual([stored]);
});

it.each([
  ["membership", (value: VpnDownloadPlan) => { value.ranges[0]!.chapterIds = [31, 22]; }],
  ["selection", (value: VpnDownloadPlan) => { value.ranges[0]!.selectedChapterIds = [31]; }],
  ["range identity", (value: VpnDownloadPlan) => { value.ranges[0]!.id = "changed"; }],
  ["work identity", (value: VpnDownloadPlan) => { value.novelId = 99; }],
  ["checkpoint", (value: VpnDownloadPlan) => { value.ranges[0]!.checkpoint = 1; }],
  ["generation", (value: VpnDownloadPlan) => { value.ranges[0]!.generation = 1; }],
] as const)("rejects an update that changes immutable %s or bypasses settlement", async (_label, mutate) => {
  await createVpnDownloadPlan(plan(), jobs());
  const value = plan();
  mutate(value);
  await expect(updateVpnDownloadPlan(value, 0)).rejects.toThrow();
  expect(await listVpnDownloadPlans()).toEqual([plan()]);
});

it("rejects wrong-generation, out-of-order, wrong-range and duplicate settlement without clearing recovery", async () => {
  const value = plan();
  value.ranges[0]!.attemptedProfileIds = ["profile-a", "spare"];
  value.ranges[0]!.attemptProfileId = "spare";
  value.ranges[0]!.challenge = { kind: "cloudflare", url: "https://source.test/work" };
  await createVpnDownloadPlan(value, jobs(value));
  await expect(settleVpnDownloadChapter("plan-1", "lane-a", 31, 1)).rejects.toThrow(/generation/i);
  await expect(settleVpnDownloadChapter("plan-1", "lane-a", 22, 2)).rejects.toThrow(/order|next/i);
  await expect(settleVpnDownloadChapter("plan-1", "lane-a", 4, 2)).rejects.toThrow(/range|order|next/i);
  expect(await listVpnDownloadPlans()).toEqual([value]);
  const settled = await settleVpnDownloadChapter("plan-1", "lane-a", 31, 2);
  expect(settled.ranges[0]).toMatchObject({ checkpoint: 1, attemptedProfileIds: [], attemptProfileId: null, challenge: null });
  expect(settled.ranges[1]).toEqual(value.ranges[1]);
  await expect(settleVpnDownloadChapter("plan-1", "lane-a", 31, 2)).rejects.toThrow(/order|settled|next/i);
  expect(queueRows().map(row => row.chapter_id)).toEqual([4, 12, 22]);
  const completed = await settleVpnDownloadChapter("plan-1", "lane-a", 22, 2);
  expect(completed.ranges[0]).toMatchObject({ checkpoint: 2, phase: "completed" });
});

it("serializes concurrent settlements without losing another range's checkpoint", async () => {
  await createVpnDownloadPlan(plan(), jobs());
  await Promise.all([
    settleVpnDownloadChapter("plan-1", "lane-a", 31, 2),
    settleVpnDownloadChapter("plan-1", "lane-b", 4, 2),
  ]);
  const [stored] = await listVpnDownloadPlans();
  expect(stored?.revision).toBe(2);
  expect(stored?.ranges.map(range => range.checkpoint)).toEqual([1, 1]);
  expect(queueRows().map(row => row.chapter_id)).toEqual([12, 22]);
});

it.each(["completed", "cancelled"] as const)("reuses a %s range's released profile without changing its historical state, including reopen", async terminalPhase => {
  await createVpnDownloadPlan(plan(), jobs());
  let current: VpnDownloadPlan;
  if (terminalPhase === "completed") {
    await settleVpnDownloadChapter("plan-1", "lane-a", 31, 2);
    current = await settleVpnDownloadChapter("plan-1", "lane-a", 22, 2);
  } else {
    current = await cancelVpnDownloadRange("plan-1", "lane-a");
  }
  const historical = structuredClone(current.ranges[0]);
  const queue = queueRows();
  current.ranges[1]!.profileId = "profile-a";
  current.ranges[1]!.profileHash = current.ranges[0]!.profileHash;
  current.ranges[1]!.generation += 1;
  const updated = await updateVpnDownloadPlan(current, current.revision);
  expect(updated.ranges[0]).toEqual(historical);
  expect(updated.ranges[1]!.profileId).toBe("profile-a");
  expect(queueRows()).toEqual(queue);
  sqlite.close();
  sqlite = new DatabaseSync(join(directory, "norea.db"));
  expect(await listVpnDownloadPlans()).toEqual([updated]);
  expect((await getVpnDownloadRangeJobs("plan-1", "lane-b")).map(job => job.id)).toEqual([4, 12]);
});

it("still rejects duplicate profile assignments between unfinished ranges", async () => {
  await createVpnDownloadPlan(plan(), jobs());
  const value = plan();
  value.ranges[1]!.profileId = "profile-a";
  value.ranges[1]!.generation += 1;
  await expect(updateVpnDownloadPlan(value, 0)).rejects.toThrow(/distinct/i);
  expect(await listVpnDownloadPlans()).toEqual([plan()]);
});

it("rolls back the checkpoint and recovery reset when deleting its queued job fails", async () => {
  const value = plan();
  value.ranges[0]!.attemptedProfileIds = ["profile-a"];
  await createVpnDownloadPlan(value, jobs(value));
  sqlite.exec("CREATE TRIGGER reject_settle BEFORE DELETE ON chapter_download_queue WHEN old.chapter_id=31 BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END");
  await expect(settleVpnDownloadChapter("plan-1", "lane-a", 31, 2)).rejects.toThrow("injected settlement failure");
  expect(await listVpnDownloadPlans()).toEqual([value]);
  expect(queueRows()).toHaveLength(4);
});

it("cancels only its own enrolled jobs and plan, retaining chapters, ordinary work and other plans", async () => {
  enqueueOrdinary();
  const ordinary = queueRows();
  const chapters = sqlite.prepare("SELECT * FROM chapter ORDER BY id").all();
  const other: VpnDownloadPlan = {
    ...plan(), id: "plan-2", pluginId: "other-source", novelId: 99, mode: "single",
    ranges: [range("other-range", "other-profile", [90], [90])],
  };
  await createVpnDownloadPlan(other, jobs(other));
  await createVpnDownloadPlan(plan(), jobs());
  await cancelVpnDownloadPlan("plan-1");
  await cancelVpnDownloadPlan("plan-1");
  expect(await listVpnDownloadPlans()).toEqual([other]);
  expect(queueRows().filter(row => row.chapter_id === 7)).toEqual(ordinary);
  expect(queueRows().map(row => row.chapter_id)).toEqual([7, 90]);
  expect(sqlite.prepare("SELECT * FROM chapter ORDER BY id").all()).toEqual(chapters);
});

it("never settles or deletes an ordinary job that replaced a missing enrolled job", async () => {
  await createVpnDownloadPlan(plan(), jobs());
  sqlite.exec("DELETE FROM chapter_download_queue WHERE chapter_id=31");
  enqueueOrdinary(31);
  const ordinary = queueRows().filter(row => row.chapter_id === 31);
  await expect(settleVpnDownloadChapter("plan-1", "lane-a", 31, 2)).rejects.toThrow(/owner|ownership|enrolled/i);
  await cancelVpnDownloadPlan("plan-1");
  expect(queueRows()).toEqual(ordinary);
});

it("cancels one range atomically while preserving sibling state, queued jobs and all chapter data", async () => {
  enqueueOrdinary();
  const ordinary = queueRows();
  const chapters = sqlite.prepare("SELECT * FROM chapter ORDER BY id").all();
  const value = plan();
  value.ranges[0]!.phase = "running";
  value.ranges[0]!.attemptedProfileIds = ["profile-a", "spare"];
  value.ranges[0]!.attemptProfileId = "spare";
  value.ranges[1]!.userPaused = true;
  await createVpnDownloadPlan(value, jobs(value));
  const siblingQueue = queueRows().filter(row => row.chapter_id === 4 || row.chapter_id === 12);
  const cancelled = await cancelVpnDownloadRange("plan-1", "lane-a");
  expect(cancelled.revision).toBe(1);
  expect(cancelled.ranges[0]).toEqual({ ...value.ranges[0], phase: "cancelled" });
  expect(cancelled.ranges[1]).toEqual(value.ranges[1]);
  expect(await listVpnDownloadPlans()).toEqual([cancelled]);
  expect(await getVpnDownloadRangeJobs("plan-1", "lane-a")).toEqual([]);
  expect(queueRows().filter(row => row.chapter_id === 4 || row.chapter_id === 12)).toEqual(siblingQueue);
  expect(queueRows().filter(row => row.chapter_id === 7)).toEqual(ordinary);
  expect(queueRows().map(row => row.chapter_id)).toEqual([4, 7, 12]);
  expect(sqlite.prepare("SELECT * FROM chapter ORDER BY id").all()).toEqual(chapters);
  await expect(settleVpnDownloadChapter("plan-1", "lane-a", 31, 2)).rejects.toThrow();
  expect(await cancelVpnDownloadRange("plan-1", "lane-a")).toEqual(cancelled);
  const siblingSettled = await settleVpnDownloadChapter("plan-1", "lane-b", 4, 2);
  expect(siblingSettled.ranges[0]).toEqual(cancelled.ranges[0]);
  expect(siblingSettled.ranges[1]!.checkpoint).toBe(1);
});

it("rolls back per-range cancellation if an owned queue row cannot be deleted", async () => {
  await createVpnDownloadPlan(plan(), jobs());
  const original = queueRows();
  sqlite.exec("CREATE TRIGGER reject_cancel BEFORE DELETE ON chapter_download_queue WHEN old.chapter_id=22 BEGIN SELECT RAISE(ABORT,'injected range cancellation failure'); END");
  await expect(cancelVpnDownloadRange("plan-1", "lane-a")).rejects.toThrow("injected range cancellation failure");
  expect(await listVpnDownloadPlans()).toEqual([plan()]);
  expect(queueRows()).toEqual(original);
});

it("preserves jobs with another owner during range cancellation and rejects missing identities", async () => {
  await createVpnDownloadPlan(plan(), jobs());
  sqlite.exec("DELETE FROM chapter_download_queue WHERE chapter_id=31");
  enqueueOrdinary(31);
  const ordinary = queueRows().filter(row => row.chapter_id === 31);
  await expect(cancelVpnDownloadRange("missing", "lane-a")).rejects.toThrow(/not found/i);
  await expect(cancelVpnDownloadRange("plan-1", "missing")).rejects.toThrow(/not found/i);
  await cancelVpnDownloadRange("plan-1", "lane-a");
  expect(queueRows().filter(row => row.chapter_id === 31)).toEqual(ordinary);
  expect(queueRows().map(row => row.chapter_id)).toEqual([4, 12, 31]);
});

it("removes still-owned jobs when range cancellation repeats an already persisted cancelled state", async () => {
  await createVpnDownloadPlan(plan(), jobs());
  const cancelledState = plan();
  cancelledState.ranges[0]!.phase = "cancelled";
  const updated = await updateVpnDownloadPlan(cancelledState, 0);
  expect(await cancelVpnDownloadRange("plan-1", "lane-a")).toEqual(updated);
  expect(queueRows().map(row => row.chapter_id)).toEqual([4, 12]);
});

it("publishes, restores and cancels a range larger than the existing SQLite query and insert chunks", async () => {
  const ids = Array.from({ length: 1_003 }, (_, index) => index + 1_000);
  sqlite.exec("BEGIN");
  const insert = sqlite.prepare("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(?,42,?,'Large range',?)");
  for (const [position, id] of ids.entries()) insert.run(id, `/${id}`, position + 10);
  sqlite.exec("COMMIT");
  const value: VpnDownloadPlan = { ...plan(), mode: "single", ranges: [range("large-range", "profile-large", ids, ids)] };
  await createVpnDownloadPlan(value, jobs(value));
  expect((await getVpnDownloadRangeJobs("plan-1", "large-range")).map(job => job.id)).toEqual(ids);
  expect((await listVpnDownloadPlans())[0]!.ranges[0]!.chapterIds).toEqual(ids);
  await cancelVpnDownloadRange("plan-1", "large-range");
  expect(queueRows()).toEqual([]);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter WHERE id>=1000").get()?.count).toBe(1_003);
});

it.each([
  ["empty identity", (value: VpnDownloadPlan) => { value.id = ""; }],
  ["empty selection", (value: VpnDownloadPlan) => { for (const range of value.ranges) range.selectedChapterIds = []; }],
  ["checkpoint bounds", (value: VpnDownloadPlan) => { value.ranges[0]!.checkpoint = 3; }],
  ["overlap", (value: VpnDownloadPlan) => { value.ranges[1]!.chapterIds.unshift(22); value.ranges[1]!.startChapterId = 22; }],
  ["missing canonical hole", (value: VpnDownloadPlan) => { value.ranges[0]!.chapterIds = [31, 22]; }],
  ["reversed selected order", (value: VpnDownloadPlan) => { value.ranges[0]!.selectedChapterIds.reverse(); }],
  ["duplicate range", (value: VpnDownloadPlan) => { value.ranges[1]!.id = "lane-a"; }],
  ["duplicate profile", (value: VpnDownloadPlan) => { value.ranges[1]!.profileId = "profile-a"; }],
  ["wrong source", (value: VpnDownloadPlan) => { value.pluginId = "other-source"; }],
  ["non-string policy", (value: VpnDownloadPlan) => { value.policies.captcha = ["pause"] as never; }],
  ["non-string phase", (value: VpnDownloadPlan) => { value.ranges[0]!.phase = ["paused"] as never; }],
  ["wrong chapter work", (value: VpnDownloadPlan) => { value.ranges[1]!.chapterIds = [90]; value.ranges[1]!.selectedChapterIds = [90]; value.ranges[1]!.startChapterId = 90; value.ranges[1]!.endChapterId = 90; }],
] as const)("rejects invalid plan %s before publication", async (_label, mutate) => {
  const value = plan();
  mutate(value);
  await expect(createVpnDownloadPlan(value, jobs(value))).rejects.toThrow();
  expect(await listVpnDownloadPlans()).toEqual([]);
  expect(queueRows()).toEqual([]);
});

it.each([
  ["missing chapter", (value: ChapterDownloadJob[]) => { value.pop(); }],
  ["duplicate chapter", (value: ChapterDownloadJob[]) => { value.push(value[0]!); }],
  ["wrong range", (value: ChapterDownloadJob[]) => { value[0]!.vpnRangeId = "lane-b"; }],
  ["wrong plan", (value: ChapterDownloadJob[]) => { value[0]!.vpnPlanId = "other-plan"; }],
  ["wrong source", (value: ChapterDownloadJob[]) => { value[0]!.pluginId = "other-source"; }],
  ["wrong work", (value: ChapterDownloadJob[]) => { value[0]!.novelId = 99; }],
  ["wrong chapter path", (value: ChapterDownloadJob[]) => { value[0]!.chapterPath = "/different"; }],
  ["wrong work path", (value: ChapterDownloadJob[]) => { value[0]!.novelPath = "/different"; }],
  ["invalid title payload", (value: ChapterDownloadJob[]) => { value[0]!.title = 123 as never; }],
  ["non-string priority", (value: ChapterDownloadJob[]) => { value[0]!.priority = ["user"] as never; }],
  ["non-string content type", (value: ChapterDownloadJob[]) => { value[0]!.contentType = ["html"] as never; }],
] as const)("rejects invalid job %s before publication", async (_label, mutate) => {
  const value = jobs();
  mutate(value);
  await expect(createVpnDownloadPlan(plan(), value)).rejects.toThrow();
  expect(await listVpnDownloadPlans()).toEqual([]);
  expect(queueRows()).toEqual([]);
});

it.each(["{", "{}", JSON.stringify({ ...plan(), id: "different-id" }), JSON.stringify({ ...plan(), revision: 4 })])(
  "reports malformed persisted plan %s instead of dropping or repairing it", async payload => {
    sqlite.prepare("INSERT INTO vpn_download_plan VALUES('plan-1',?,0)").run(payload);
    await expect(listVpnDownloadPlans()).rejects.toThrow(/plan-1/);
    expect(sqlite.prepare("SELECT payload FROM vpn_download_plan").get()?.payload).toBe(payload);
  },
);

it.each(["{", "{}", JSON.stringify({ ...jobs()[0], vpnRangeId: "lane-b" }), JSON.stringify({ ...jobs()[0], id: 22 })])(
  "reports malformed or misowned queued payload %s without advancing the checkpoint", async payload => {
    await createVpnDownloadPlan(plan(), jobs());
    sqlite.prepare("UPDATE chapter_download_queue SET job_json=? WHERE chapter_id=31").run(payload);
    await expect(getVpnDownloadRangeJobs("plan-1", "lane-a")).rejects.toThrow();
    await expect(settleVpnDownloadChapter("plan-1", "lane-a", 31, 2)).rejects.toThrow();
    expect(await listVpnDownloadPlans()).toEqual([plan()]);
  },
);
