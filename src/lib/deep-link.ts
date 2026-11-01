import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  parseTaskNotificationAction,
  type TaskNotificationAction,
} from "./tasks/native-notification-actions";

export type DeepLink =
  | { kind: "repo-add"; repoUrl: string }
  | { kind: "task-notification"; action: TaskNotificationAction }
  | { kind: "unknown"; raw: string };

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
    const repoUrl = url.searchParams.get("url");
    if (repoUrl && repoUrl.trim() !== "") {
      return { kind: "repo-add", repoUrl: repoUrl.trim() };
    }
  }
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
