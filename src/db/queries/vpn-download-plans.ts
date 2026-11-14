import type { ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import type {
  VpnDownloadPlan,
  VpnDownloadRangeState,
} from "../../lib/tasks/vpn-download-types";
import { describeError } from "../../lib/errors";
import {
  assertByteBudget,
  MAX_CHAPTER_TITLE_BYTES,
  MAX_CHAPTER_URL_BYTES,
  MAX_INLINE_IPC_BYTES,
} from "../../lib/performance-budgets";
import { invokeDbMutation, invokeDbQuery } from "../ipc";
import type { ChapterDownloadQueue, vpnDownloadPlanTable } from "../schema";

type PlanRow = typeof vpnDownloadPlanTable.$inferSelect;
type QueueRow = Pick<ChapterDownloadQueue, "chapterId" | "jobJson">;

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
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function assertPlan(value: unknown): asserts value is VpnDownloadPlan {
  if (
    !isObject(value) ||
    !isIdentity(value.id) ||
    !isIdentity(value.batchId) ||
    !isIdentity(value.pluginId) ||
    !isChapterId(value.novelId) ||
    !isIdentity(value.title) ||
    (value.mode !== "single" && value.mode !== "parallel") ||
    !isCounter(value.createdAt) ||
    !isCounter(value.revision) ||
    !isObject(value.policies) ||
    (value.policies.captcha !== "pause" &&
      value.policies.captcha !== "nextProfile") ||
    (value.policies.cloudflare !== "pause" &&
      value.policies.cloudflare !== "nextProfile") ||
    !Array.isArray(value.ranges) ||
    value.ranges.length === 0
  ) {
    throw new Error("Invalid VPN download plan identity, policies or ranges.");
  }
  const rangeIds = new Set<string>();
  const chapterIds = new Set<number>();
  let selectedCount = 0;
  for (const range of value.ranges) {
    if (
      !isObject(range) ||
      !isIdentity(range.id) ||
      (range.profileId === null
        ? range.profileHash !== null
        : !isIdentity(range.profileId) || !isIdentity(range.profileHash)) ||
      !isCounter(range.checkpoint) ||
      !isCounter(range.generation) ||
      typeof range.userPaused !== "boolean" ||
      (range.pauseReason !== null && typeof range.pauseReason !== "string") ||
      typeof range.phase !== "string" ||
      !["paused", "connecting", "running", "completed", "cancelled"].includes(
        range.phase,
      ) ||
      !Array.isArray(range.chapterIds) ||
      !range.chapterIds.length ||
      !range.chapterIds.every(isChapterId) ||
      !Array.isArray(range.selectedChapterIds) ||
      !range.selectedChapterIds.every(isChapterId) ||
      !Array.isArray(range.attemptedProfileIds) ||
      !range.attemptedProfileIds.every(isIdentity) ||
      new Set(range.attemptedProfileIds).size !==
        range.attemptedProfileIds.length ||
      (range.attemptProfileId !== null && !isIdentity(range.attemptProfileId))
    ) {
      throw new Error("Invalid VPN download range state.");
    }
    if (
      range.consumedReallowRevisions !== undefined &&
      (!isObject(range.consumedReallowRevisions) ||
        !Object.entries(range.consumedReallowRevisions).every(
          ([id, revision]) => isIdentity(id) && isCounter(revision),
        ))
    ) {
      throw new Error("Invalid VPN download reallow revisions.");
    }
    if (rangeIds.has(range.id)) {
      throw new Error("VPN download range IDs must be distinct.");
    }
    rangeIds.add(range.id);
    for (const id of range.chapterIds) {
      if (chapterIds.has(id)) {
        throw new Error("VPN download ranges overlap or repeat a chapter.");
      }
      chapterIds.add(id);
    }
    const selected = new Set(range.selectedChapterIds);
    selectedCount += range.selectedChapterIds.length;
    if (
      range.startChapterId !== range.chapterIds[0] ||
      range.endChapterId !== range.chapterIds.at(-1) ||
      !sameIds(
        range.selectedChapterIds,
        range.chapterIds.filter((id) => selected.has(id)),
      ) ||
      range.checkpoint > range.selectedChapterIds.length ||
      (range.phase === "completed" &&
        range.checkpoint !== range.selectedChapterIds.length)
    ) {
      throw new Error(
        "Invalid VPN download range boundaries, selection order or checkpoint.",
      );
    }
    if (range.challenge !== null) {
      if (
        !isObject(range.challenge) ||
        (range.challenge.kind !== "captcha" &&
          range.challenge.kind !== "cloudflare" &&
          range.challenge.kind !== "forbidden") ||
        typeof range.challenge.url !== "string"
      ) {
        throw new Error("Invalid VPN download source challenge.");
      }
      const url = new URL(range.challenge.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        throw new Error("Invalid VPN download source challenge URL.");
      }
    }
  }
  if (selectedCount === 0) {
    throw new Error(
      "A VPN download plan requires at least one selected chapter.",
    );
  }
}

function serialize(value: unknown, label: string): string {
  const payload = JSON.stringify(value);
  assertByteBudget(
    new TextEncoder().encode(payload).byteLength,
    MAX_INLINE_IPC_BYTES,
    label,
  );
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
    throw new Error(
      `Invalid stored VPN download plan ${row.id}: ${describeError(error)}`,
      { cause: error },
    );
  }
}

function snapshot(plan: VpnDownloadPlan): VpnDownloadPlan {
  assertPlan(plan);
  return parsePlan({
    id: plan.id,
    revision: plan.revision,
    payload: serialize(plan, "VPN download plan"),
  });
}

function assertJob(value: unknown): asserts value is ChapterDownloadJob {
  if (
    !isObject(value) ||
    !isChapterId(value.id) ||
    !isIdentity(value.pluginId) ||
    !isIdentity(value.chapterPath) ||
    !isIdentity(value.title) ||
    (value.novelId !== undefined &&
      value.novelId !== null &&
      !isChapterId(value.novelId))
  ) {
    throw new Error("Invalid VPN download queue payload.");
  }
  if (
    value.vpnWorkPaused !== undefined &&
    typeof value.vpnWorkPaused !== "boolean"
  ) {
    throw new Error("Invalid pending VPN work pause.");
  }
  for (const key of [
    "batchId",
    "batchTitle",
    "pluginName",
    "chapterName",
    "chapterNumber",
    "novelName",
    "novelPath",
    "vpnBatchId",
    "vpnPlanId",
    "vpnRangeId",
  ]) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      typeof value[key] !== "string"
    ) {
      throw new Error(`Invalid download queue payload field ${key}.`);
    }
  }
  if (value.vpnBatchId != null && !isIdentity(value.vpnBatchId)) {
    throw new Error("Invalid pending VPN batch ownership.");
  }
  if (
    value.priority !== undefined &&
    value.priority !== null &&
    (typeof value.priority !== "string" ||
      !["interactive", "user", "normal", "deferred", "background"].includes(
        value.priority,
      ))
  ) {
    throw new Error("Invalid download queue priority.");
  }
  if (
    value.contentType !== undefined &&
    value.contentType !== null &&
    (typeof value.contentType !== "string" ||
      !["html", "text", "markdown", "pdf", "epub"].includes(value.contentType))
  ) {
    throw new Error("Invalid download queue content type.");
  }
  assertByteBudget(
    new TextEncoder().encode(value.chapterPath).byteLength,
    MAX_CHAPTER_URL_BYTES,
    "Chapter path",
  );
  assertByteBudget(
    new TextEncoder().encode(value.title).byteLength,
    MAX_CHAPTER_TITLE_BYTES,
    "Chapter title",
  );
}

export function parseStoredChapterDownloadJob(
  row: QueueRow,
): ChapterDownloadJob {
  try {
    const value: unknown = JSON.parse(row.jobJson);
    assertJob(value);
    if (value.id !== row.chapterId) {
      throw new Error("Queue chapter identity differs from its payload.");
    }
    return value;
  } catch (error) {
    throw new Error(
      `Invalid stored download queue chapter ${row.chapterId}: ${describeError(error)}`,
      { cause: error },
    );
  }
}

function assertJobOwner(
  job: ChapterDownloadJob,
  plan: VpnDownloadPlan,
  range: VpnDownloadRangeState,
): void {
  if (
    job.vpnPlanId !== plan.id ||
    job.vpnRangeId !== range.id ||
    (job.vpnBatchId != null && job.vpnBatchId !== plan.batchId) ||
    job.pluginId !== plan.pluginId ||
    job.novelId !== plan.novelId
  ) {
    throw new Error(
      `Download queue chapter ${job.id} ownership differs from its enrolled VPN range.`,
    );
  }
}

export async function readVpnDownloadPlan(
  id: string,
): Promise<VpnDownloadPlan | undefined> {
  const plan = await invokeDbQuery<VpnDownloadPlan | null>("db_vpn_plan_read", {
    id,
  });
  return plan ?? undefined;
}

export async function createVpnDownloadPlan(
  input: VpnDownloadPlan,
  jobs: readonly ChapterDownloadJob[],
): Promise<void> {
  const plan = snapshot(input);
  if (plan.revision !== 0) {
    throw new Error("A new VPN download plan must start at revision zero.");
  }
  const capturedJobs: unknown = JSON.parse(
    serialize(jobs, "VPN download jobs"),
  );
  if (!Array.isArray(capturedJobs)) {
    throw new Error("Invalid VPN download jobs.");
  }
  const enrolled = new Map<number, VpnDownloadRangeState>();
  for (const range of plan.ranges) {
    if (range.phase === "cancelled") continue;
    for (const id of range.selectedChapterIds.slice(range.checkpoint)) {
      enrolled.set(id, range);
    }
  }
  if (capturedJobs.length !== enrolled.size) {
    throw new Error(
      "VPN jobs must cover exactly the unfinished selected chapters.",
    );
  }
  const queued = new Set<number>();
  for (const job of capturedJobs) {
    assertJob(job);
    const range = enrolled.get(job.id);
    if (!range || queued.has(job.id)) {
      throw new Error("VPN jobs contain an unselected or duplicate chapter.");
    }
    assertJobOwner(job, plan, range);
    if (job.batchId !== plan.batchId) {
      throw new Error("VPN download job belongs to another batch.");
    }
    queued.add(job.id);
  }
  const publishedJobs = capturedJobs as ChapterDownloadJob[];
  await invokeDbMutation("db_vpn_plan_create", {
    plan,
    jobs: publishedJobs,
  });
}

export async function listVpnDownloadPlans(): Promise<VpnDownloadPlan[]> {
  return invokeDbQuery<VpnDownloadPlan[]>("db_vpn_plan_list");
}

export async function getVpnDownloadRangeJobs(
  planId: string,
  rangeId: string,
): Promise<ChapterDownloadJob[]> {
  return invokeDbQuery<ChapterDownloadJob[]>("db_vpn_plan_get_range_jobs", {
    planId,
    rangeId,
  });
}

export async function updateVpnDownloadPlan(
  input: VpnDownloadPlan,
  expectedRevision: number,
  options?: VpnDownloadPlanUpdateOptions,
): Promise<VpnDownloadPlan> {
  const plan = snapshot(input);
  const restartRangeId = options?.restartPassRangeId;
  if (options && !isIdentity(restartRangeId)) {
    throw new Error(
      "An explicit VPN profile pass restart requires a range ID.",
    );
  }
  return invokeDbMutation<VpnDownloadPlan>("db_vpn_plan_update", {
    plan,
    expectedRevision,
    restartPassRangeId: restartRangeId ?? null,
  });
}

export async function settleVpnDownloadChapter(
  planId: string,
  rangeId: string,
  chapterId: number,
  expectedGeneration: number,
): Promise<VpnDownloadPlan> {
  return invokeDbMutation<VpnDownloadPlan>("db_vpn_plan_settle_chapter", {
    planId,
    rangeId,
    chapterId,
    expectedGeneration,
  });
}

export async function cancelVpnDownloadRange(
  planId: string,
  rangeId: string,
): Promise<VpnDownloadPlan> {
  return invokeDbMutation<VpnDownloadPlan>("db_vpn_plan_cancel_range", {
    planId,
    rangeId,
  });
}

export async function cancelVpnDownloadPlan(planId: string): Promise<void> {
  await invokeDbMutation("db_vpn_plan_cancel", { planId });
}
