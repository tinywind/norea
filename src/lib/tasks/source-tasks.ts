import {
  useSiteBrowserStore,
  type SiteBrowserContext,
} from "../../store/site-browser";
import { getPluginBaseUrl } from "../plugins/base-url";
import { sourceAccessScopeKey } from "../plugins/source-access";
import type { Plugin } from "../plugins/types";
import { redactUrlForLog } from "../url-log";
import {
  taskScheduler,
  type SourceAccessBlock,
  type SourceTaskKind,
  type TaskHandle,
  type TaskPriority,
  type TaskRunContext,
  type TaskSubject,
} from "./scheduler";

export type SourceAccessBrowserOutcome = "keep-paused" | "verify";

interface SourceTaskOptions<T> {
  plugin: Pick<Plugin, "getBaseUrl" | "id" | "name">;
  kind: SourceTaskKind;
  title: string;
  priority?: Exclude<TaskPriority, "background">;
  subject?: TaskSubject;
  dedupeKey?: string;
  canCancel?: boolean;
  exclusive?: boolean;
  run: (context: TaskRunContext) => Promise<T>;
}

function debugOpenSiteTask(message: string, data?: unknown): void {
  console.debug(`[site-browser:task] ${message}`, data);
}

export function enqueueSourceTask<T>({
  canCancel,
  dedupeKey,
  exclusive,
  kind,
  plugin,
  priority = "normal",
  run,
  subject,
  title,
}: SourceTaskOptions<T>): TaskHandle<T> {
  const sourceAccessUrl = getPluginBaseUrl(plugin);
  const sourceAccessScope = sourceAccessScopeKey(sourceAccessUrl);
  return taskScheduler.enqueueSource<T>({
    kind,
    priority,
    title,
    source: { id: plugin.id, name: plugin.name },
    subject: { ...subject, pluginId: plugin.id },
    dedupeKey,
    canCancel,
    exclusive,
    sourceAccessScopeKey: sourceAccessScope,
    run:
      kind === "source.openSite" || kind === "source.clearCookies"
        ? run
        : async (context) => {
            const result = await run(context);
            context.confirmSourceAccess?.();
            return result;
          },
  });
}

function enqueueSiteBrowserTask(
  plugin: Pick<Plugin, "getBaseUrl" | "id" | "name">,
  url: string,
  title: string,
  context: SiteBrowserContext,
): TaskHandle<void> {
  const handle = enqueueSourceTask<void>({
    plugin,
    kind: "source.openSite",
    priority: "interactive",
    exclusive: true,
    title,
    subject: { url },
    dedupeKey: `source.openSite:${plugin.id}:${url}`,
    run: async ({ signal, taskId }) =>
      new Promise<void>((resolve, reject) => {
        const queuedBrowser = useSiteBrowserStore.getState();
        if (
          !queuedBrowser.visible ||
          queuedBrowser.sourceId !== plugin.id ||
          queuedBrowser.currentUrl !== url ||
          queuedBrowser.taskId !== taskId
        ) {
          reject(new DOMException("Task was cancelled.", "AbortError"));
          return;
        }
        debugOpenSiteTask("started", {
          sourceId: plugin.id,
          sourceName: plugin.name,
          taskId,
          url: redactUrlForLog(url),
        });
        const handleAbort = () => {
          const siteBrowser = useSiteBrowserStore.getState();
          if (
            siteBrowser.visible &&
            siteBrowser.sourceId === plugin.id &&
            siteBrowser.currentUrl === url &&
            siteBrowser.taskId === taskId
          ) {
            siteBrowser.hide();
          }
          debugOpenSiteTask("cancelled", {
            sourceId: plugin.id,
            taskId,
            url: redactUrlForLog(url),
          });
          cleanup();
          reject(new DOMException("Task was cancelled.", "AbortError"));
        };
        const cleanup = () => {
          signal.removeEventListener("abort", handleAbort);
          unsubscribe();
        };
        const unsubscribe = useSiteBrowserStore.subscribe((state) => {
          if (
            !state.visible ||
            state.sourceId !== plugin.id ||
            state.currentUrl !== url ||
            state.taskId !== taskId
          ) {
            debugOpenSiteTask("closed", {
              sourceId: plugin.id,
              taskId,
              url: redactUrlForLog(url),
              visible: state.visible,
              currentUrl: state.currentUrl
                ? redactUrlForLog(state.currentUrl)
                : null,
            });
            cleanup();
            resolve();
          }
        });

        signal.addEventListener("abort", handleAbort, { once: true });
        debugOpenSiteTask("openAt", {
          sourceId: plugin.id,
          taskId,
          url: redactUrlForLog(url),
        });
        useSiteBrowserStore.getState().startLoading(plugin.id, url, taskId);
        if (signal.aborted) handleAbort();
      }),
  });
  useSiteBrowserStore
    .getState()
    .queueAt(plugin.id, url, handle.id, context);
  return handle;
}

export function enqueueOpenSiteTask(
  plugin: Pick<Plugin, "getBaseUrl" | "id" | "name">,
  url: string,
  title: string,
): TaskHandle<void> {
  return enqueueSiteBrowserTask(plugin, url, title, { mode: "browse" });
}

export function enqueueSourceAccessBrowserTask(
  plugin: Pick<Plugin, "getBaseUrl" | "id" | "name">,
  block: SourceAccessBlock,
  title: string,
): TaskHandle<SourceAccessBrowserOutcome> {
  const handle = enqueueSiteBrowserTask(
    plugin,
    block.challenge.url,
    title,
    {
      mode: "source-access",
      challenge: { ...block.challenge },
      revision: block.revision,
      scopeKey: block.scopeKey,
      sourceName: plugin.name,
    },
  );
  return {
    id: handle.id,
    promise: handle.promise.then(() => {
      const completion = useSiteBrowserStore.getState().completion;
      if (
        completion?.taskId === handle.id &&
        completion.revision === block.revision &&
        completion.scopeKey === block.scopeKey &&
        (completion.outcome === "keep-paused" ||
          completion.outcome === "verify")
      ) {
        return completion.outcome;
      }
      throw new DOMException("Task was cancelled.", "AbortError");
    }),
  };
}
