import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import type { VpnDownloadPlan } from "../../lib/tasks/vpn-download-types";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import { createVpnDownloadPlan, getVpnDownloadRangeJobs } from "./vpn-download-plans";

let sqlite: DatabaseSync;
let directory: string;
let operations: Promise<unknown>;

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = operations.then(run);
  operations = result.catch(() => undefined);
  return result;
}

const raw = {
  select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(
    Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never,
  ),
  execute: async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never);
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  },
};

function job(id: number): ChapterDownloadJob {
  return { id, pluginId: "source", novelId: 42, novelPath: "/work", chapterPath: `/${id}`, title: `Chapter ${id}`, batchId: "ordinary-batch" };
}

function insert(id: number, extra: Record<string, unknown> = {}, created = 10) {
  sqlite.prepare("INSERT INTO chapter_download_queue VALUES(?,?,?,20,30,4)")
    .run(id, JSON.stringify({ ...job(id), ...extra }), created);
}

function rows() {
  return sqlite.prepare("SELECT * FROM chapter_download_queue ORDER BY chapter_id").all();
}

beforeEach(() => {
  mkdirSync(".tmp", { recursive: true });
  directory = mkdtempSync(".tmp/vpn-pending-queue-");
  sqlite = new DatabaseSync(join(directory, "norea.db"));
  for (const path of ["src-tauri/src/schema.sql", "src-tauri/src/migrations/0002_vpn_download_plans.sql", "src-tauri/src/migrations/0003_vpn_download_profile_issues.sql"]) {
    sqlite.exec(readFileSync(path, "utf8"));
  }
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(42,'source','/work','Work',1)");
  const chapter = sqlite.prepare("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(?,42,?,?,?)");
  for (let id = 1; id <= 600; id++) chapter.run(id, `/${id}`, `Chapter ${id}`, id);
  operations = Promise.resolve();
  vi.mocked(getDb).mockResolvedValue({
    select: (...args: Parameters<typeof raw.select>) => exclusive(() => raw.select(...args)),
    execute: (...args: Parameters<typeof raw.execute>) => exclusive(() => raw.execute(...args)),
  } as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(run => exclusive(async () => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = await run(raw as never); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }));
});

afterEach(async () => {
  await operations;
  sqlite.close();
  rmSync(directory, { recursive: true });
});

it("persists pending VPN intent before a profile or plan exists and coalesces its exact owner", async () => {
  const queue = await import("./chapter-download-queue");
  await queue.enqueuePendingVpnDownloadJobs("run-a", [job(1), job(2)]);
  const before = rows();
  await queue.enqueuePendingVpnDownloadJobs("run-a", [job(1)]);
  expect(rows()).toEqual(before);
  expect((await queue.listPendingVpnDownloadJobs()).map(row => row.job)).toEqual([
    { ...job(1), vpnBatchId: "run-a" }, { ...job(2), vpnBatchId: "run-a" },
  ]);
  expect(await queue.listOrdinaryChapterDownloadJobs()).toEqual([]);
  sqlite.close(); sqlite = new DatabaseSync(join(directory, "norea.db"));
  expect((await queue.listPendingVpnDownloadJobs()).map(row => row.job.id)).toEqual([1, 2]);
});

it.each([{}, { vpnBatchId: "another-run" }, { vpnPlanId: "another-plan", vpnRangeId: "another-range" }])("does not overwrite an existing owner during new admission: %j", async owner => {
  const queue = await import("./chapter-download-queue");
  insert(1, owner);
  const before = rows();
  await expect(queue.enqueuePendingVpnDownloadJobs("run-a", [job(2), job(1)])).rejects.toThrow(/owner|owned|conflict/i);
  expect(rows()).toEqual(before);
});

it("adopts a captured ordinary owner without deleting its row or losing queue history", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1, {}, 20); insert(2, {}, 10);
  const captured = await queue.listOrdinaryChapterDownloadJobs();
  expect(captured.map(row => row.job.id)).toEqual([2, 1]);
  expect(await queue.adoptOrdinaryChapterDownloadJobs("run-a", captured)).toEqual([
    { ...job(2), vpnBatchId: "run-a" }, { ...job(1), vpnBatchId: "run-a" },
  ]);
  expect(rows()).toMatchObject([
    { chapter_id: 1, created_at_ms: 20, leased_at_ms: null, attempt_count: 4 },
    { chapter_id: 2, created_at_ms: 10, leased_at_ms: null, attempt_count: 4 },
  ]);
});

it("leaves server-backed local work outside the source handover cohort", async () => {
  const queue = await import("./chapter-download-queue");
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name,is_local) VALUES(43,'local','/local','Server-backed local work',1); UPDATE chapter SET novel_id=43 WHERE id=2");
  insert(1); insert(2, { pluginId: "local", novelId: 43 });
  const captured = await queue.listOrdinaryChapterDownloadJobs();
  expect(captured.map(row => row.job.id)).toEqual([1]);
  await queue.adoptOrdinaryChapterDownloadJobs("run-a", captured);
  expect(rows()).toMatchObject([{ chapter_id: 1, job_json: JSON.stringify({ ...job(1), vpnBatchId: "run-a" }) },
    { chapter_id: 2, job_json: JSON.stringify({ ...job(2), pluginId: "local", novelId: 43 }) }]);
});

it("rechecks source-work eligibility atomically instead of adopting a work converted after capture", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1); insert(2);
  const captured = await queue.listOrdinaryChapterDownloadJobs();
  sqlite.exec("UPDATE novel SET is_local=1 WHERE id=42");
  const before = rows();
  await expect(queue.adoptOrdinaryChapterDownloadJobs("run-a", captured)).rejects.toThrow(/eligible|stale|changed/i);
  expect(rows()).toEqual(before);
});

it("rolls back the complete adoption when a captured job was replaced", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1); insert(2);
  const captured = await queue.listOrdinaryChapterDownloadJobs();
  sqlite.prepare("UPDATE chapter_download_queue SET job_json=?,updated_at_ms=21 WHERE chapter_id=2")
    .run(JSON.stringify({ ...job(2), title: "Replacement request" }));
  const before = rows();
  await expect(queue.adoptOrdinaryChapterDownloadJobs("run-a", captured)).rejects.toThrow(/stale|changed|owner/i);
  expect(rows()).toEqual(before);
});

it("does not resurrect a chapter whose ordinary owner already completed", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1); insert(2);
  const captured = await queue.listOrdinaryChapterDownloadJobs();
  sqlite.exec("DELETE FROM chapter_download_queue WHERE chapter_id=2; UPDATE chapter SET is_downloaded=1 WHERE id=2");
  const before = rows();
  await expect(queue.adoptOrdinaryChapterDownloadJobs("run-a", captured)).rejects.toThrow(/missing|stale|changed/i);
  expect(rows()).toEqual(before);
  expect(sqlite.prepare("SELECT is_downloaded FROM chapter WHERE id=2").get()).toEqual({ is_downloaded: 1 });
});

it("cancels only the pending batch owner and leaves enrolled and ordinary jobs untouched", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1, { vpnBatchId: "run-a" }); insert(2, { vpnBatchId: "run-a" });
  insert(3, { vpnBatchId: "run-b" }); insert(4, { vpnBatchId: "run-a", vpnPlanId: "plan-a", vpnRangeId: "range-a" }); insert(5);
  expect(await queue.cancelPendingVpnDownloadBatch("run-a")).toBe(2);
  expect(await queue.cancelPendingVpnDownloadBatch("run-a")).toBe(0);
  expect(rows().map(row => row.chapter_id)).toEqual([3, 4, 5]);
});

it("cancels one pending request without discarding another work that shares its run identity", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1, { vpnBatchId: "run-a" }); insert(2, { vpnBatchId: "run-a" });
  insert(3, { vpnBatchId: "run-b" }); insert(4, { vpnBatchId: "run-a", vpnPlanId: "plan-a", vpnRangeId: "range-a" });
  expect(await queue.cancelPendingVpnDownloadJobs("run-a", [1, 3, 4])).toBe(1);
  expect(rows().map(row => row.chapter_id)).toEqual([2, 3, 4]);
});

it("persists an exact pending work hold without changing another batch or enrolled ownership", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1, { vpnBatchId: "run-a" }); insert(2, { vpnBatchId: "run-b" });
  insert(3, { vpnBatchId: "run-a", vpnPlanId: "plan-a", vpnRangeId: "range-a" });
  expect(await queue.setPendingVpnDownloadJobsPaused("run-a", [1, 2, 3], true)).toBe(1);
  sqlite.close(); sqlite = new DatabaseSync(join(directory, "norea.db"));
  expect((await queue.listPendingVpnDownloadJobs()).map(row => row.job)).toEqual([
    { ...job(1), vpnBatchId: "run-a", vpnWorkPaused: true }, { ...job(2), vpnBatchId: "run-b" },
  ]);
  expect(await queue.setPendingVpnDownloadJobsPaused("run-a", [1, 2, 3], false)).toBe(1);
  expect((await queue.listPendingVpnDownloadJobs())[0]!.job).toEqual({ ...job(1), vpnBatchId: "run-a" });
  expect(JSON.parse(String(rows()[2]!.job_json))).toEqual({ ...job(3), vpnBatchId: "run-a", vpnPlanId: "plan-a", vpnRangeId: "range-a" });
});

it("enrolls its own pending rows atomically without resetting their native queue history", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1); insert(2);
  await queue.adoptOrdinaryChapterDownloadJobs("run-a", await queue.listOrdinaryChapterDownloadJobs());
  const plan: VpnDownloadPlan = {
    id: "plan-a", batchId: "run-a", pluginId: "source", novelId: 42, title: "Work", mode: "parallel",
    policies: { captcha: "nextProfile", cloudflare: "nextProfile" }, createdAt: 1, revision: 0,
    ranges: [{ id: "range-a", profileId: "profile-a", profileHash: "a".repeat(64), chapterIds: [1, 2], selectedChapterIds: [1, 2], startChapterId: 1, endChapterId: 2,
      checkpoint: 0, phase: "paused", userPaused: false, pauseReason: null, attemptedProfileIds: [], attemptProfileId: null, generation: 1, challenge: null }],
  };
  const enrolled = [1, 2].map(id => ({ ...job(id), batchId: "run-a", vpnBatchId: "run-a", vpnPlanId: "plan-a", vpnRangeId: "range-a" }));
  await createVpnDownloadPlan(plan, enrolled);
  expect(await getVpnDownloadRangeJobs("plan-a", "range-a")).toEqual(enrolled);
  expect(await queue.listPendingVpnDownloadJobs()).toEqual([]);
  expect(rows()).toMatchObject([{ created_at_ms: 10, attempt_count: 4 }, { created_at_ms: 10, attempt_count: 4 }]);
});

it("adopts more than one SQL chunk while preserving every selected job", async () => {
  const queue = await import("./chapter-download-queue");
  for (let id = 1; id <= 600; id++) insert(id);
  expect(await queue.adoptOrdinaryChapterDownloadJobs("run-a", await queue.listOrdinaryChapterDownloadJobs())).toHaveLength(600);
  expect(await queue.listPendingVpnDownloadJobs()).toHaveLength(600);
  expect(rows().every(row => row.created_at_ms === 10 && row.attempt_count === 4)).toBe(true);
});


it("keeps explicit server downloads out of VPN handover and rejects direct VPN admission", async () => {
  const queue = await import("./chapter-download-queue");
  insert(1); insert(2, { serverOnly: true });
  const captured = await queue.listOrdinaryChapterDownloadJobs();
  expect(captured.map(row => row.job.id)).toEqual([1]);
  const serverJobJson = JSON.stringify({ ...job(2), serverOnly: true });
  await expect(queue.adoptOrdinaryChapterDownloadJobs("run-a", [{
    job: { ...job(2), serverOnly: true }, jobJson: serverJobJson, updatedAtMs: 20,
  }])).rejects.toThrow("Content server");
  await expect(queue.enqueuePendingVpnDownloadJobs("run-a", [{ ...job(3), serverOnly: true }]))
    .rejects.toThrow("Content server");
  await queue.adoptOrdinaryChapterDownloadJobs("run-a", captured);
  expect(rows()).toMatchObject([
    { chapter_id: 1, job_json: JSON.stringify({ ...job(1), vpnBatchId: "run-a" }) },
    { chapter_id: 2, job_json: serverJobJson },
  ]);
});
