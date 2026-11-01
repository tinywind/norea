import type { TaskNotificationGroupKey } from "./task-types";

export type TaskNotificationAction =
  | { type: "openTasks" }
  | { type: "pause" | "resume"; groupKey: TaskNotificationGroupKey }
  | { type: "verifySource"; sourceId: string; scopeKey: string; revision: number };

const GROUP_KEYS = new Set<string>(["downloads", "libraryMetadata", "libraryUpdates", "search"]);

export function parseTaskNotificationAction(value: unknown): TaskNotificationAction | null {
  if (value === null || typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  if (action.type === "openTasks") return { type: "openTasks" };
  if ((action.type === "pause" || action.type === "resume") &&
      typeof action.groupKey === "string" && GROUP_KEYS.has(action.groupKey)) {
    return { type: action.type, groupKey: action.groupKey as TaskNotificationGroupKey };
  }
  if (action.type === "verifySource" && typeof action.sourceId === "string" && action.sourceId !== "" &&
      typeof action.scopeKey === "string" && action.scopeKey !== "" &&
      typeof action.revision === "number" && Number.isSafeInteger(action.revision) && action.revision > 0) {
    return { type: "verifySource", sourceId: action.sourceId, scopeKey: action.scopeKey, revision: action.revision };
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
