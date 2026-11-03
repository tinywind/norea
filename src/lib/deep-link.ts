import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  parseTaskNotificationAction,
  type TaskNotificationAction,
} from "./tasks/native-notification-actions";

export type DeepLink =
  | { kind: "repo-add"; repoUrl: string }
  | { kind: "task-notification"; action: TaskNotificationAction }
  | { kind: "unknown"; raw: string };

const ROW_ID = "([1-9]\\d{0,15})";
const NOVEL_PATH = new RegExp(`^/${ROW_ID}$`);
const NOVEL_CHAPTER_PATH = new RegExp(`^/${ROW_ID}/chapter/${ROW_ID}$`);

/**
 * Notification targets as fixed paths: `norea://updates`, `norea://attention`,
 * `norea://novel/<novelId>` and `norea://novel/<novelId>/chapter/<chapterId>`.
 */
function parseNotificationTargetLink(url: URL): TaskNotificationAction | null {
  if (url.search || url.hash || url.username || url.password || url.port) return null;
  if (url.host === "updates" && (url.pathname === "" || url.pathname === "/")) {
    return { type: "openUpdates" };
  }
  if (url.host === "attention" && (url.pathname === "" || url.pathname === "/")) {
    return { type: "openAttention" };
  }
  if (url.host !== "novel") return null;
  const chapter = NOVEL_CHAPTER_PATH.exec(url.pathname);
  if (chapter) {
    return parseTaskNotificationAction({
      type: "openChapter", novelId: Number(chapter[1]), chapterId: Number(chapter[2]),
    });
  }
  const novel = NOVEL_PATH.exec(url.pathname);
  return novel ? parseTaskNotificationAction({ type: "openNovel", novelId: Number(novel[1]) }) : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function parseDeepLink(raw: string): DeepLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "unknown", raw };
  }
  if (url.protocol !== "norea:") {
    return { kind: "unknown", raw };
  }
  if (url.host === "repo" && url.pathname === "/add") {
    const repoUrl = url.searchParams.get("url")?.trim() ?? "";
    if (isHttpUrl(repoUrl)) return { kind: "repo-add", repoUrl };
  }
  const target = parseNotificationTargetLink(url);
  if (target) return { kind: "task-notification", action: target };
  if (url.host === "tasks" && (url.pathname === "" || url.pathname === "/") &&
      !url.username && !url.password && !url.hash) {
    const fields = [...url.searchParams.keys()];
    if (fields.length === 0) {
      return { kind: "task-notification", action: { type: "openTasks" } };
    }
    const allowed = new Set(["action", "sourceId", "scopeKey", "revision"]);
    const sourceId = url.searchParams.get("sourceId");
    const scopeKey = url.searchParams.get("scopeKey");
    const revision = url.searchParams.get("revision");
    if (fields.length === 4 && new Set(fields).size === 4 && fields.every(field => allowed.has(field)) &&
        url.searchParams.get("action") === "verifySource" && sourceId?.trim() && scopeKey?.trim() &&
        revision !== null && /^[1-9]\d*$/.test(revision)) {
      const action = parseTaskNotificationAction({
        type: "verifySource", sourceId, scopeKey, revision: Number(revision),
      });
      if (action) return { kind: "task-notification", action };
    }
  }
  return { kind: "unknown", raw };
}

export interface DeepLinkHandlers {
  onRepoAdd: (repoUrl: string) => void;
  onTaskNotificationAction?: (action: TaskNotificationAction) => void;
  onUnknown?: (raw: string) => void;
}

/**
 * Subscribe to OS-level deep-link openings (URI scheme `norea://`).
 *
 * Returns an unlisten function suitable for cleanup in a React effect.
 * Errors during plugin invocation propagate so the caller decides
 * whether to log or ignore.
 */
export async function startDeepLinkListener(
  handlers: DeepLinkHandlers,
): Promise<() => void> {
  let active = true;
  let initializing = true;
  const pending: string[] = [];
  const deliver = (urls: readonly string[]) => {
    if (!active) return;
    for (const raw of urls) {
      const parsed = parseDeepLink(raw);
      switch (parsed.kind) {
        case "repo-add":
          handlers.onRepoAdd(parsed.repoUrl);
          break;
        case "task-notification":
          handlers.onTaskNotificationAction?.(parsed.action);
          break;
        case "unknown":
          handlers.onUnknown?.(parsed.raw);
          break;
      }
    }
  };
  const unlisten = await onOpenUrl(urls => {
    if (!active) return;
    if (initializing) pending.push(...urls);
    else deliver(urls);
  });
  try {
    const current = await getCurrent();
    initializing = false;
    deliver([...new Set([...(current ?? []), ...pending])]);
  } catch (error) {
    active = false;
    unlisten();
    throw error;
  }
  return () => {
    active = false;
    unlisten();
  };
}
