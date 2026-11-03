import type { TaskNotificationGroupKey } from "./task-types";

export type TaskNotificationAction =
  | { type: "openTasks" }
  | { type: "openAttention" }
  | { type: "openUpdates" }
  | { type: "openNovel"; novelId: number }
  | { type: "openChapter"; novelId: number; chapterId: number }
  | { type: "pause" | "resume"; groupKey: TaskNotificationGroupKey }
  | { type: "verifySource"; sourceId: string; scopeKey: string; revision: number }
  | { type: "verifyVpnDownload"; planId: string; sourceId: string; rangeId: string; profileId: string; generation: number; checkpoint: number };

const GROUP_KEYS = new Set<string>(["downloads", "libraryMetadata", "libraryUpdates", "search"]);

function isBoundedIdentity(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isRowId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseTaskNotificationAction(value: unknown): TaskNotificationAction | null {
  if (value === null || typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  if (action.type === "openTasks") return { type: "openTasks" };
  if (action.type === "openAttention") return { type: "openAttention" };
  if (action.type === "openUpdates") return { type: "openUpdates" };
  if (action.type === "openNovel" && isRowId(action.novelId)) {
    return { type: "openNovel", novelId: action.novelId };
  }
  if (action.type === "openChapter" && isRowId(action.novelId) && isRowId(action.chapterId)) {
    return { type: "openChapter", novelId: action.novelId, chapterId: action.chapterId };
  }
  if ((action.type === "pause" || action.type === "resume") &&
      typeof action.groupKey === "string" && GROUP_KEYS.has(action.groupKey)) {
    return { type: action.type, groupKey: action.groupKey as TaskNotificationGroupKey };
  }
  if (action.type === "verifySource" && isBoundedIdentity(action.sourceId) && isBoundedIdentity(action.scopeKey, 2048) &&
      typeof action.revision === "number" && Number.isSafeInteger(action.revision) && action.revision > 0) {
    return { type: "verifySource", sourceId: action.sourceId, scopeKey: action.scopeKey, revision: action.revision };
  }
  if (action.type === "verifyVpnDownload" && isBoundedIdentity(action.planId, 128) &&
      isBoundedIdentity(action.sourceId) && isBoundedIdentity(action.rangeId, 128) && isBoundedIdentity(action.profileId, 128) &&
      typeof action.generation === "number" && Number.isSafeInteger(action.generation) && action.generation > 0 &&
      typeof action.checkpoint === "number" && Number.isSafeInteger(action.checkpoint) && action.checkpoint >= 0) {
    return {
      type: "verifyVpnDownload", planId: action.planId, sourceId: action.sourceId, rangeId: action.rangeId,
      profileId: action.profileId, generation: action.generation, checkpoint: action.checkpoint,
    };
  }
  return null;
}

export function parseTaskNotificationActions(value: string): TaskNotificationAction[] {
  let actions: unknown;
  try { actions = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(actions)) return [];
  return actions.flatMap(value => {
    const action = parseTaskNotificationAction(value);
    return action ? [action] : [];
  });
}
