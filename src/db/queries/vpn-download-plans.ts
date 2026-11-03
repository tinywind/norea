import type Database from "@tauri-apps/plugin-sql";
import type { ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "../../lib/tasks/vpn-download-types";
import { describeError } from "../../lib/errors";
import {
  assertByteBudget,
  MAX_CHAPTER_TITLE_BYTES,
  MAX_CHAPTER_URL_BYTES,
  MAX_INLINE_IPC_BYTES,
  MAX_ROUTE_QUERY_ROWS,
} from "../../lib/performance-budgets";
import { getDb, runDatabaseTransaction } from "../client";
import type { Chapter, ChapterDownloadQueue, Novel, vpnDownloadPlanTable } from "../schema";

type PlanRow = typeof vpnDownloadPlanTable.$inferSelect;
type QueueRow = Pick<ChapterDownloadQueue, "chapterId" | "jobJson">;
type CatalogRow = Pick<Chapter, "id" | "path" | "position">;

export interface VpnDownloadPlanUpdateOptions {
  restartPassRangeId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isChapterId(value: unknown): value is number {
  return isCounter(value) && value > 0;
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function assertPlan(value: unknown): asserts value is VpnDownloadPlan {
  if (!isObject(value) || !isIdentity(value.id) || !isIdentity(value.batchId) || !isIdentity(value.pluginId) ||
    !isChapterId(value.novelId) || !isIdentity(value.title) ||
    (value.mode !== "single" && value.mode !== "parallel") ||
    !isCounter(value.createdAt) || !isCounter(value.revision) ||
    !isObject(value.policies) ||
    (value.policies.captcha !== "pause" && value.policies.captcha !== "nextProfile") ||
    (value.policies.cloudflare !== "pause" && value.policies.cloudflare !== "nextProfile") ||
    !Array.isArray(value.ranges) || value.ranges.length === 0) {
    throw new Error("Invalid VPN download plan identity, policies or ranges.");
  }
  const rangeIds = new Set<string>();
  const chapterIds = new Set<number>();
  let selectedCount = 0;
  for (const range of value.ranges) {
    if (!isObject(range) || !isIdentity(range.id) ||
      (range.profileId === null ? range.profileHash !== null : !isIdentity(range.profileId) || !isIdentity(range.profileHash)) ||
      !isCounter(range.checkpoint) ||
      !isCounter(range.generation) || typeof range.userPaused !== "boolean" ||
      (range.pauseReason !== null && typeof range.pauseReason !== "string") ||
      typeof range.phase !== "string" || !["paused", "connecting", "running", "completed", "cancelled"].includes(range.phase) ||
      !Array.isArray(range.chapterIds) || !range.chapterIds.length || !range.chapterIds.every(isChapterId) ||
      !Array.isArray(range.selectedChapterIds) || !range.selectedChapterIds.every(isChapterId) ||
      !Array.isArray(range.attemptedProfileIds) || !range.attemptedProfileIds.every(isIdentity) ||
      new Set(range.attemptedProfileIds).size !== range.attemptedProfileIds.length ||
      (range.attemptProfileId !== null && !isIdentity(range.attemptProfileId))) {
      throw new Error("Invalid VPN download range state.");
    }
    if (range.consumedReallowRevisions !== undefined && (!isObject(range.consumedReallowRevisions) ||
      !Object.entries(range.consumedReallowRevisions).every(([id, revision]) => isIdentity(id) && isCounter(revision)))) {
      throw new Error("Invalid VPN download reallow revisions.");
    }
    if (rangeIds.has(range.id)) throw new Error("VPN download range IDs must be distinct.");
    rangeIds.add(range.id);
    for (const id of range.chapterIds) {
      if (chapterIds.has(id)) throw new Error("VPN download ranges overlap or repeat a chapter.");
      chapterIds.add(id);
    }
    const selected = new Set(range.selectedChapterIds);
    selectedCount += range.selectedChapterIds.length;
    if (range.startChapterId !== range.chapterIds[0] || range.endChapterId !== range.chapterIds.at(-1) ||
      !sameIds(range.selectedChapterIds, range.chapterIds.filter(id => selected.has(id))) ||
      range.checkpoint > range.selectedChapterIds.length ||
      (range.phase === "completed" && range.checkpoint !== range.selectedChapterIds.length)) {
      throw new Error("Invalid VPN download range boundaries, selection order or checkpoint.");
    }
    if (range.challenge !== null) {
      if (!isObject(range.challenge) ||
        (range.challenge.kind !== "captcha" && range.challenge.kind !== "cloudflare") ||
        typeof range.challenge.url !== "string") {
        throw new Error("Invalid VPN download source challenge.");
      }
      const url = new URL(range.challenge.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Invalid VPN download source challenge URL.");
      }
    }
  }
  if (selectedCount === 0) throw new Error("A VPN download plan requires at least one selected chapter.");
}

function serialize(value: unknown, label: string): string {
  const payload = JSON.stringify(value);
  assertByteBudget(new TextEncoder().encode(payload).byteLength, MAX_INLINE_IPC_BYTES, label);
  return payload;
}

function parsePlan(row: PlanRow): VpnDownloadPlan {
  try {
    const value: unknown = JSON.parse(row.payload);
    assertPlan(value);
    if (value.id !== row.id || value.revision !== row.revision) {
      throw new Error("Payload identity or revision differs from its row.");
    }
    return value;
  } catch (error) {
    throw new Error(`Invalid stored VPN download plan ${row.id}: ${describeError(error)}`, { cause: error });
  }
}

function snapshot(plan: VpnDownloadPlan): VpnDownloadPlan {
  assertPlan(plan);
  return parsePlan({ id: plan.id, revision: plan.revision, payload: serialize(plan, "VPN download plan") });
}

function assertJob(value: unknown): asserts value is ChapterDownloadJob {
  if (!isObject(value) || !isChapterId(value.id) || !isIdentity(value.pluginId) ||
    !isIdentity(value.chapterPath) || !isIdentity(value.title) ||
    (value.novelId !== undefined && value.novelId !== null && !isChapterId(value.novelId))) {
    throw new Error("Invalid VPN download queue payload.");
  }
  if (value.vpnWorkPaused !== undefined && typeof value.vpnWorkPaused !== "boolean") throw new Error("Invalid pending VPN work pause.");
  for (const key of ["batchId", "batchTitle", "pluginName", "chapterName", "chapterNumber", "novelName", "novelPath", "vpnBatchId", "vpnPlanId", "vpnRangeId"]) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
      throw new Error(`Invalid download queue payload field ${key}.`);
    }
  }
  if (value.vpnBatchId != null && !isIdentity(value.vpnBatchId)) {
    throw new Error("Invalid pending VPN batch ownership.");
  }
  if (value.priority !== undefined && value.priority !== null &&
    (typeof value.priority !== "string" || !["interactive", "user", "normal", "deferred", "background"].includes(value.priority))) {
    throw new Error("Invalid download queue priority.");
  }
  if (value.contentType !== undefined && value.contentType !== null &&
    (typeof value.contentType !== "string" || !["html", "text", "markdown", "pdf", "epub"].includes(value.contentType))) {
    throw new Error("Invalid download queue content type.");
  }
  assertByteBudget(new TextEncoder().encode(value.chapterPath).byteLength, MAX_CHAPTER_URL_BYTES, "Chapter path");
  assertByteBudget(new TextEncoder().encode(value.title).byteLength, MAX_CHAPTER_TITLE_BYTES, "Chapter title");
}

export function parseStoredChapterDownloadJob(row: QueueRow): ChapterDownloadJob {
  try {
    const value: unknown = JSON.parse(row.jobJson);
    assertJob(value);
    if (value.id !== row.chapterId) throw new Error("Queue chapter identity differs from its payload.");
    return value;
  } catch (error) {
    throw new Error(`Invalid stored download queue chapter ${row.chapterId}: ${describeError(error)}`, { cause: error });
  }
}

function assertJobOwner(job: ChapterDownloadJob, plan: VpnDownloadPlan, range: VpnDownloadRangeState): void {
  if (job.vpnPlanId !== plan.id || job.vpnRangeId !== range.id ||
    (job.vpnBatchId != null && job.vpnBatchId !== plan.batchId) ||
    job.pluginId !== plan.pluginId || job.novelId !== plan.novelId) {
    throw new Error(`Download queue chapter ${job.id} ownership differs from its enrolled VPN range.`);
  }
}

function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, index) => `$${start + index}`).join(",");
}

export async function readVpnDownloadPlan(db: Database, id: string): Promise<VpnDownloadPlan | undefined> {
  const [row] = await db.select<PlanRow[]>("SELECT id,payload,revision FROM vpn_download_plan WHERE id=$1", [id]);
  return row && parsePlan(row);
}

async function requirePlan(db: Database, id: string): Promise<VpnDownloadPlan> {
  const plan = await readVpnDownloadPlan(db, id);
  if (!plan) throw new Error(`VPN download plan ${id} not found.`);
  return plan;
}

function requireRange(plan: VpnDownloadPlan, id: string): VpnDownloadRangeState {
  const range = plan.ranges.find(range => range.id === id);
  if (!range) throw new Error(`VPN download range ${id} not found in plan ${plan.id}.`);
  return range;
}

async function readQueue(db: Database, ids: readonly number[]): Promise<QueueRow[]> {
  const rows: QueueRow[] = [];
  for (let offset = 0; offset < ids.length; offset += MAX_ROUTE_QUERY_ROWS) {
    const chunk = ids.slice(offset, offset + MAX_ROUTE_QUERY_ROWS);
    rows.push(...await db.select<QueueRow[]>(
      `SELECT chapter_id AS chapterId,job_json AS jobJson FROM chapter_download_queue WHERE chapter_id IN (${placeholders(chunk.length)})`, chunk,
    ));
  }
  return rows;
}

async function publicationCatalog(db: Database, plan: VpnDownloadPlan): Promise<{ novelPath: string; chapters: Map<number, CatalogRow> }> {
  const [novel] = await db.select<Pick<Novel, "path">[]>(
    "SELECT path FROM novel WHERE id=$1 AND plugin_id=$2 AND is_local=0", [plan.novelId, plan.pluginId],
  );
  if (!novel) throw new Error("VPN download source/work identity does not match an existing source novel.");
  const chapters = new Map<number, CatalogRow>();
  const ids = plan.ranges.flatMap(range => range.chapterIds);
  const chunkSize = MAX_ROUTE_QUERY_ROWS - 1;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const rows = await db.select<CatalogRow[]>(
      `SELECT id,path,position FROM chapter WHERE novel_id=$1 AND id IN (${placeholders(chunk.length, 2)})`, [plan.novelId, ...chunk],
    );
    for (const row of rows) chapters.set(row.id, row);
  }
  if (chapters.size !== ids.length) throw new Error("VPN range contains a missing chapter or another work's chapter.");
  let previousEnd: CatalogRow | undefined;
  for (const range of plan.ranges) {
    const start = chapters.get(range.startChapterId)!;
    const end = chapters.get(range.endChapterId)!;
    if (previousEnd && (previousEnd.position > start.position ||
      (previousEnd.position === start.position && previousEnd.id >= start.id))) {
      throw new Error("VPN ranges are not in canonical catalog order.");
    }
    let cursor = { position: start.position, id: start.id - 1 };
    let index = 0;
    while (true) {
      const rows = await db.select<CatalogRow[]>(
        `SELECT id,path,position FROM chapter WHERE novel_id=$1
         AND (position,id)>=($2,$3) AND (position,id)<=($4,$5) AND (position,id)>($6,$7)
         ORDER BY position,id LIMIT $8`,
        [plan.novelId, start.position, start.id, end.position, end.id, cursor.position, cursor.id, MAX_ROUTE_QUERY_ROWS],
      );
      for (const row of rows) {
        if (range.chapterIds[index++] !== row.id) throw new Error("VPN range must preserve the full contiguous canonical catalog.");
      }
      if (rows.length < MAX_ROUTE_QUERY_ROWS) break;
      cursor = rows.at(-1)!;
    }
    if (index !== range.chapterIds.length) throw new Error("VPN range is reversed or missing canonical chapters.");
    previousEnd = end;
  }
  return { novelPath: novel.path, chapters };
}

export async function createVpnDownloadPlan(input: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]): Promise<void> {
  const plan = snapshot(input);
  if (plan.revision !== 0) throw new Error("A new VPN download plan must start at revision zero.");
  const capturedJobs: unknown = JSON.parse(serialize(jobs, "VPN download jobs"));
  if (!Array.isArray(capturedJobs)) throw new Error("Invalid VPN download jobs.");
  const enrolled = new Map<number, VpnDownloadRangeState>();
  for (const range of plan.ranges) {
    if (range.phase === "cancelled") continue;
    for (const id of range.selectedChapterIds.slice(range.checkpoint)) enrolled.set(id, range);
  }
  if (capturedJobs.length !== enrolled.size) throw new Error("VPN jobs must cover exactly the unfinished selected chapters.");
  const queued = new Set<number>();
  for (const job of capturedJobs) {
    assertJob(job);
    const range = enrolled.get(job.id);
    if (!range || queued.has(job.id)) throw new Error("VPN jobs contain an unselected or duplicate chapter.");
    assertJobOwner(job, plan, range);
    if (job.batchId !== plan.batchId) throw new Error("VPN download job belongs to another batch.");
    queued.add(job.id);
  }
  const publishedJobs = capturedJobs as ChapterDownloadJob[];
  await runDatabaseTransaction(async db => {
    const { novelPath, chapters } = await publicationCatalog(db, plan);
    for (const job of publishedJobs) {
      if (job.chapterPath !== chapters.get(job.id)!.path || (job.novelPath != null && job.novelPath !== novelPath)) {
        throw new Error(`VPN download chapter ${job.id} source/work path does not match its catalog.`);
      }
    }
    await db.execute("INSERT INTO vpn_download_plan(id,payload,revision) VALUES($1,$2,$3)",
      [plan.id, serialize(plan, "VPN download plan"), plan.revision]);
    const now = Date.now();
    const existing = new Map((await readQueue(db, publishedJobs.map(job => job.id))).map(row => [row.chapterId, row]));
    const freshJobs: ChapterDownloadJob[] = [];
    for (const job of publishedJobs) {
      const row = existing.get(job.id);
      if (job.vpnBatchId == null) {
        if (row) throw new Error(`Queued chapter ${job.id} already has a download owner.`);
        freshJobs.push(job);
        continue;
      }
      if (!row) throw new Error(`Pending VPN chapter ${job.id} is missing or was cancelled.`);
      const pending = parseStoredChapterDownloadJob(row);
      if (pending.vpnBatchId !== plan.batchId || pending.vpnPlanId != null || pending.vpnRangeId != null ||
        pending.pluginId !== job.pluginId || pending.novelId !== job.novelId || pending.chapterPath !== job.chapterPath) {
        throw new Error(`Chapter ${job.id} has a different pending download owner.`);
      }
      const payloadFields = ["pluginName", "chapterName", "chapterNumber", "contentType", "novelName", "novelPath", "priority", "title"] as const;
      if (payloadFields.some(key => (pending[key] ?? null) !== (job[key] ?? null))) {
        throw new Error(`Pending chapter ${job.id} content payload changed during VPN enrollment.`);
      }
      const result = await db.execute(
        `UPDATE chapter_download_queue SET job_json=$1,updated_at_ms=$2,leased_at_ms=NULL
         WHERE chapter_id=$3 AND job_json=$4`,
        [serialize(job, "VPN download queue job"), now, job.id, row.jobJson],
      );
      if (result.rowsAffected !== 1) throw new Error(`Pending VPN chapter ${job.id} changed owners.`);
    }
    const chunkSize = Math.floor(MAX_ROUTE_QUERY_ROWS / 4);
    for (let offset = 0; offset < freshJobs.length; offset += chunkSize) {
      const chunk = freshJobs.slice(offset, offset + chunkSize);
      const params = chunk.flatMap(job => [job.id, serialize(job, "VPN download queue job"), now, now]);
      const values = chunk.map((_, index) => `(${placeholders(4, index * 4 + 1)},NULL,0)`).join(",");
      await db.execute(`INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms,leased_at_ms,attempt_count) VALUES ${values}`, params);
    }
  });
}

export async function listVpnDownloadPlans(): Promise<VpnDownloadPlan[]> {
  const db = await getDb();
  const rows = await db.select<PlanRow[]>("SELECT id,payload,revision FROM vpn_download_plan ORDER BY id");
  return rows.map(parsePlan);
}

export async function getVpnDownloadRangeJobs(planId: string, rangeId: string): Promise<ChapterDownloadJob[]> {
  return runDatabaseTransaction(async db => {
    const plan = await requirePlan(db, planId);
    const range = requireRange(plan, rangeId);
    if (range.phase === "cancelled") return [];
    const ids = range.selectedChapterIds.slice(range.checkpoint);
    const rows = new Map((await readQueue(db, ids)).map(row => [row.chapterId, row]));
    return ids.map(id => {
      const row = rows.get(id);
      if (!row) throw new Error(`VPN download range ${rangeId} is missing queued chapter ${id}.`);
      const job = parseStoredChapterDownloadJob(row);
      assertJobOwner(job, plan, range);
      return job;
    });
  });
}

async function writePlan(db: Database, plan: VpnDownloadPlan, expectedRevision: number): Promise<VpnDownloadPlan> {
  const updated = { ...plan, revision: expectedRevision + 1 };
  assertPlan(updated);
  const result = await db.execute("UPDATE vpn_download_plan SET payload=$1,revision=$2 WHERE id=$3 AND revision=$4",
    [serialize(updated, "VPN download plan"), updated.revision, plan.id, expectedRevision]);
  if (result.rowsAffected !== 1) throw new Error(`VPN download plan ${plan.id} has a stale revision or is missing.`);
  return updated;
}

export async function updateVpnDownloadPlan(
  input: VpnDownloadPlan, expectedRevision: number, options?: VpnDownloadPlanUpdateOptions,
): Promise<VpnDownloadPlan> {
  const plan = snapshot(input);
  const restartRangeId = options?.restartPassRangeId;
  if (options && !isIdentity(restartRangeId)) throw new Error("An explicit VPN profile pass restart requires a range ID.");
  return runDatabaseTransaction(async db => {
    const stored = await requirePlan(db, plan.id);
    if (stored.revision !== expectedRevision || plan.revision !== expectedRevision) {
      throw new Error(`VPN download plan ${plan.id} has a stale revision.`);
    }
    if (restartRangeId !== undefined) {
      const target = requireRange(stored, restartRangeId);
      if (target.phase !== "paused") throw new Error("Stop the VPN range and persist its paused state before restarting its profile pass.");
    }
    if (plan.batchId !== stored.batchId || plan.pluginId !== stored.pluginId || plan.novelId !== stored.novelId ||
      plan.title !== stored.title || plan.mode !== stored.mode || plan.createdAt !== stored.createdAt ||
      plan.policies.captcha !== stored.policies.captcha || plan.policies.cloudflare !== stored.policies.cloudflare ||
      plan.ranges.length !== stored.ranges.length) {
      throw new Error("VPN download plan identity and configuration are immutable.");
    }
    for (const [index, range] of plan.ranges.entries()) {
      const previous = stored.ranges[index]!;
      if (range.id !== previous.id || range.startChapterId !== previous.startChapterId ||
        range.endChapterId !== previous.endChapterId || !sameIds(range.chapterIds, previous.chapterIds) ||
        !sameIds(range.selectedChapterIds, previous.selectedChapterIds) || range.checkpoint !== previous.checkpoint ||
        range.generation < previous.generation) {
        throw new Error("VPN range membership and checkpoints are immutable outside settlement; generation cannot regress.");
      }
      const sameChallenge = previous.challenge?.kind === range.challenge?.kind && previous.challenge?.url === range.challenge?.url;
      if (range.id === restartRangeId) {
        if (range.phase !== "paused" || range.generation <= previous.generation || range.attemptedProfileIds.length !== 0 ||
          Object.keys(range.consumedReallowRevisions ?? {}).length !== 0 ||
          range.attemptProfileId !== null || !sameChallenge || range.profileId !== previous.profileId || range.profileHash !== previous.profileHash) {
          throw new Error("A VPN profile pass restart requires a paused target, a higher generation and an empty attempt state; profile and challenge must be preserved.");
        }
      } else if (previous.attemptedProfileIds.some((id, index) => range.attemptedProfileIds[index] !== id) ||
        Object.entries(previous.consumedReallowRevisions ?? {}).some(([id, revision]) => (range.consumedReallowRevisions?.[id] ?? -1) < revision) ||
        (previous.challenge !== null && range.challenge === null)) {
        throw new Error("VPN recovery attempts and challenges can only be cleared by full chapter settlement.");
      }
      if (restartRangeId !== undefined && range.id !== restartRangeId) {
        const changed = (["profileId", "profileHash", "phase", "userPaused", "pauseReason", "attemptProfileId", "generation"] as const)
          .some(field => range[field] !== previous[field]);
        if (changed || !sameChallenge || JSON.stringify(range.attemptedProfileIds) !== JSON.stringify(previous.attemptedProfileIds) ||
          JSON.stringify(range.consumedReallowRevisions ?? {}) !== JSON.stringify(previous.consumedReallowRevisions ?? {})) {
          throw new Error("An explicit VPN profile pass restart cannot change sibling range state.");
        }
      }
    }
    return writePlan(db, plan, expectedRevision);
  });
}

export async function settleVpnDownloadChapter(
  planId: string, rangeId: string, chapterId: number, expectedGeneration: number,
): Promise<VpnDownloadPlan> {
  return runDatabaseTransaction(async db => {
    const plan = await requirePlan(db, planId);
    const range = requireRange(plan, rangeId);
    if (range.generation !== expectedGeneration) throw new Error("Stale VPN download worker generation.");
    if (range.phase === "cancelled" || range.selectedChapterIds[range.checkpoint] !== chapterId) {
      throw new Error("VPN chapter settlement must match the next selected chapter in its range.");
    }
    const [row] = await readQueue(db, [chapterId]);
    if (!row) throw new Error(`VPN range is missing queued chapter ${chapterId}.`);
    assertJobOwner(parseStoredChapterDownloadJob(row), plan, range);
    range.checkpoint += 1;
    range.attemptedProfileIds = [];
    delete range.consumedReallowRevisions;
    range.attemptProfileId = null;
    range.challenge = null;
    if (range.checkpoint === range.selectedChapterIds.length) range.phase = "completed";
    await db.execute("DELETE FROM chapter_download_queue WHERE chapter_id=$1", [chapterId]);
    return writePlan(db, plan, plan.revision);
  });
}

async function removeOwnedJobs(db: Database, plan: VpnDownloadPlan, ranges: readonly VpnDownloadRangeState[]): Promise<void> {
  const owners = new Map(ranges.flatMap(range => range.selectedChapterIds.map(id => [id, range] as const)));
  const rows = await readQueue(db, [...owners.keys()]);
  const ownedIds: number[] = [];
  for (const row of rows) {
    const job = parseStoredChapterDownloadJob(row);
    const range = owners.get(row.chapterId)!;
    if (job.vpnPlanId !== plan.id || job.vpnRangeId !== range.id) continue;
    assertJobOwner(job, plan, range);
    ownedIds.push(row.chapterId);
  }
  for (let offset = 0; offset < ownedIds.length; offset += MAX_ROUTE_QUERY_ROWS) {
    const chunk = ownedIds.slice(offset, offset + MAX_ROUTE_QUERY_ROWS);
    await db.execute(`DELETE FROM chapter_download_queue WHERE chapter_id IN (${placeholders(chunk.length)})`, chunk);
  }
}

export async function cancelVpnDownloadRange(planId: string, rangeId: string): Promise<VpnDownloadPlan> {
  return runDatabaseTransaction(async db => {
    const plan = await requirePlan(db, planId);
    const range = requireRange(plan, rangeId);
    await removeOwnedJobs(db, plan, [range]);
    if (range.phase === "cancelled") return plan;
    range.phase = "cancelled";
    return writePlan(db, plan, plan.revision);
  });
}

export async function cancelVpnDownloadPlan(planId: string): Promise<void> {
  await runDatabaseTransaction(async db => {
    const plan = await readVpnDownloadPlan(db, planId);
    if (!plan) return;
    await removeOwnedJobs(db, plan, plan.ranges);
    await db.execute("DELETE FROM vpn_download_plan WHERE id=$1", [plan.id]);
  });
}
