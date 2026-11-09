import { addNovelsToCategory } from "../../db/queries/category";
import type { TranslationKey } from "../../i18n";
import { listAllServerWorks, openServerNovel, resolveServerNovelTarget, type ServerWorkSummary } from "../../lib/content-sync/browse";
import { registerContentDevice } from "../../lib/content-sync/device";
import { describeError } from "../../lib/errors";
import { taskScheduler, type TaskHandle } from "../../lib/tasks/scheduler";
import { useContentSyncStore } from "../../store/content-sync";
import { addQuickAddTargetToLibrary } from "./use-quick-add";

/** Works installed at once; the per-server metadata queue still serializes each install. */
export const SERVER_LIBRARY_ADD_CONCURRENCY = 3;

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/** Every work matching a server browse filter, gathered when the task starts. */
export interface ServerWorkListing {
  query: string;
  source: string;
}

function isWorkListing(works: readonly ServerWorkSummary[] | ServerWorkListing): works is ServerWorkListing {
  return !Array.isArray(works);
}

export interface ServerLibraryAddFailure {
  error: string;
  work: ServerWorkSummary;
}

export interface ServerLibraryAddResult {
  added: number;
  failed: ServerLibraryAddFailure[];
  /** Works the run did not reach because it was cancelled. */
  pending: ServerWorkSummary[];
  skipped: number;
}

export class ServerLibraryAddError extends Error {
  constructor(message: string, readonly result: ServerLibraryAddResult) {
    super(message);
    this.name = "ServerLibraryAddError";
  }
}

interface AddServerWorksOptions {
  categoryIds: readonly number[];
  onProgress: (done: number, total: number) => void;
  server: string;
  signal: AbortSignal;
  taskTitle: string;
  works: readonly ServerWorkSummary[];
}

/**
 * Adds works through the quick-add server install path, at most
 * SERVER_LIBRARY_ADD_CONCURRENCY at a time. Duplicates are dropped and works
 * already in the library are skipped. Cancelling stops new installs and
 * reports the unreached works as pending.
 */
export async function addServerWorksToLibrary({
  categoryIds,
  onProgress,
  server,
  signal,
  taskTitle,
  works,
}: AddServerWorksOptions): Promise<ServerLibraryAddResult> {
  const queue = [...new Map(works.map(work => [work.id, work])).values()];
  const settled = new Set<string>();
  const failed: ServerLibraryAddFailure[] = [];
  let added = 0;
  let skipped = 0;
  let next = 0;
  let done = 0;
  onProgress(0, queue.length);

  const worker = async () => {
    while (!signal.aborted && next < queue.length) {
      const work = queue[next++]!;
      try {
        const target = await resolveServerNovelTarget(server, work);
        if (target.novel?.inLibrary) {
          if (target.migrated) await openServerNovel(server, work);
          skipped += 1;
        } else {
          const novelId = await addQuickAddTargetToLibrary({ kind: "server", server, work }, taskTitle);
          for (const categoryId of categoryIds) await addNovelsToCategory([novelId], categoryId);
          added += 1;
        }
        settled.add(work.id);
      } catch (error) {
        console.warn("[server-library-add] failed to add a server work", { error, workId: work.id });
        failed.push({ error: describeError(error), work });
      } finally {
        done += 1;
        onProgress(done, queue.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SERVER_LIBRARY_ADD_CONCURRENCY, queue.length) }, worker));

  const failedIds = new Set(failed.map(failure => failure.work.id));
  const pending = queue.filter(work => !settled.has(work.id) && !failedIds.has(work.id));
  return { added, failed, pending, skipped };
}

export interface ServerLibraryAddRequest {
  categoryIds: readonly number[];
  /** Shown in the task title until a listing has been gathered. */
  count: number;
  server: string;
  works: readonly ServerWorkSummary[] | ServerWorkListing;
}

export function serverLibraryAddSummary(t: Translate, result: ServerLibraryAddResult): string {
  return [
    t("serverLibraryAdd.added", { count: result.added }),
    result.skipped > 0 ? t("serverLibraryAdd.skipped", { count: result.skipped }) : null,
    result.failed.length > 0 ? t("serverLibraryAdd.failedCount", { count: result.failed.length }) : null,
  ].filter(Boolean).join(" · ");
}

const LISTED_FAILURES = 5;

/** The first failed work names, then a count of the rest. */
export function failedWorkNames(result: ServerLibraryAddResult): string {
  const names = result.failed.map(failure => failure.work.novel.name);
  const rest = names.length - LISTED_FAILURES;
  return `${names.slice(0, LISTED_FAILURES).join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/**
 * Runs one main-lane task that adds the works to the library. Partial failure
 * fails the task with a ServerLibraryAddError. Retrying a failed or cancelled
 * run goes through `retry` with only the failed and unreached works, or the
 * same listing when it failed before the works were gathered.
 */
export function enqueueServerLibraryAdd(
  request: ServerLibraryAddRequest,
  t: Translate,
  retry: (works: ServerLibraryAddRequest["works"]) => TaskHandle<ServerLibraryAddResult>,
): TaskHandle<ServerLibraryAddResult> {
  const title = t("serverLibraryAdd.taskTitle", { count: request.count });
  let remaining: ServerWorkSummary[] | null = isWorkListing(request.works) ? null : [...request.works];
  return taskScheduler.enqueueMain<ServerLibraryAddResult>({
    kind: "library.addServerWorks",
    priority: "user",
    title,
    retryManually: () => retry(remaining ?? request.works),
    run: async ({ setDetail, setProgress, signal }) => {
      let works: readonly ServerWorkSummary[];
      if (!isWorkListing(request.works)) {
        works = request.works;
      } else {
        const { query, source } = request.works;
        const token = await registerContentDevice(request.server, useContentSyncStore.getState().deviceName, signal);
        works = await listAllServerWorks(request.server, token, query, source, (loaded, total) => {
          setDetail(t("serverLibraryAdd.gathering", { loaded, total }));
        }, signal);
        remaining = [...works];
      }
      const result = await addServerWorksToLibrary({
        categoryIds: request.categoryIds,
        onProgress: (current, total) => {
          setProgress({ current, total });
          setDetail(t("serverLibraryAdd.progress", { current, total }));
        },
        server: request.server,
        signal,
        taskTitle: title,
        works,
      });
      remaining = [...result.failed.map(failure => failure.work), ...result.pending];
      signal.throwIfAborted();
      if (result.failed.length > 0) {
        throw new ServerLibraryAddError(`${serverLibraryAddSummary(t, result)}: ${failedWorkNames(result)}`, result);
      }
      return result;
    },
  });
}
