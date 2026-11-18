import { useContentSyncStore } from "../../store/content-sync";
import { prepareChapterStorageTransfer } from "../chapter-storage-transfer";
import { normalizeContentServerUrl } from "../content-sync/client";
import { readServerNovelSource } from "../content-sync/novel-source";
import { runWorkContentStorageOperation } from "../content-sync/storage-operation";
import { runContentSyncOperation } from "../content-sync/sync";
import {
  createSourceChapterRenumberJournal,
  finishSourceChapterRenumber,
  flushAndReadRenumberWork,
  inspectSourceRenumberWork,
  listSourceChapterRenumberJournals,
  parseSourceChapterRenumberJournal,
  planServerChapterNumberChanges,
  planSourceChapterNumberChanges,
  readSourceChapterRenumberJournal,
  saveSourceChapterRenumberJournal,
  validateRenumberPreparation,
  type ChapterNumberMapping,
  type ChapterRenumberCoverWrite,
  type RenumberWork,
  type SourceChapterRenumberJournal,
  type StoredRenumberChapter,
} from "../source-chapter-renumber";
import { isTauriRuntime } from "../tauri-runtime";
import { runExclusiveChapterStorageOperation } from "../tasks/chapter-storage-operation";
import { cancelNovelChapterDownloadWork } from "../tasks/download-cache-delete";
import type { ChapterItem } from "./types";

interface SourceChapterReconciliationInput {
  pluginId: string;
  path: string;
  sourceNovelId: string;
  chapters: readonly ChapterItem[];
  fullCatalog: boolean;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}

/** One work lock covers publication, including ordinary refreshes that race with a renumber. */
export async function withSourceChapterNumberReconciliation<T>(
  input: SourceChapterReconciliationInput,
  publish: (journal: SourceChapterRenumberJournal | null) => Promise<T>,
): Promise<T> {
  return withChapterNumberReconciliation(input, publish);
}

/** Work sync already owns its sync queue; do not reacquire the outer sync lock or resend a POST. */
export async function withServerChapterNumberReconciliation<T>(
  input: Omit<SourceChapterReconciliationInput, "chapters" | "fullCatalog"> & {
    mappings: readonly ChapterNumberMapping[];
    coverWrite?: ChapterRenumberCoverWrite;
  },
  publish: (journal: SourceChapterRenumberJournal | null) => Promise<T>,
): Promise<T> {
  return withChapterNumberReconciliation(
    { ...input, chapters: [], fullCatalog: true },
    publish,
    input.mappings,
    input.coverWrite ? [input.coverWrite] : [],
  );
}

async function withChapterNumberReconciliation<T>(
  input: SourceChapterReconciliationInput,
  publish: (journal: SourceChapterRenumberJournal | null) => Promise<T>,
  serverMappings?: readonly ChapterNumberMapping[],
  coverWrites: readonly ChapterRenumberCoverWrite[] = [],
): Promise<T> {
  const plan = (work: RenumberWork, chapters: readonly StoredRenumberChapter[]) =>
    serverMappings
      ? planServerChapterNumberChanges(work, chapters, serverMappings)
      : planSourceChapterNumberChanges(work, chapters, input.chapters);
  const inspected = await inspectSourceRenumberWork(input.pluginId, input.path);
  const publishNormally = () =>
    runWorkContentStorageOperation(input.pluginId, input.path, () => publish(null));
  if (!inspected || inspected.work.sourceNovelId !== input.sourceNovelId) {
    return publishNormally();
  }
  const { work } = inspected;
  // Provider numbers are source facts once a user composition owns the reading list.
  if (!serverMappings && inspected.hasComposition) return publishNormally();
  input.signal?.throwIfAborted();
  if (!input.isCurrent()) return publishNormally();
  const changes = plan(work, inspected.storedChapters);
  if (!changes.length && !inspected.pendingJournalPayloads.length) {
    return publishNormally();
  }
  if (!input.fullCatalog) {
    throw new Error(
      "Chapter numbers changed. Refresh the complete chapter list before continuing.",
    );
  }

  const operation = () =>
    runExclusiveChapterStorageOperation(
      { kind: "sources", sourceIds: [input.pluginId] },
      input.signal,
      async () => {
        await cancelNovelChapterDownloadWork([work.id]);
        return runWorkContentStorageOperation(input.pluginId, input.path, async () => {
          input.signal?.throwIfAborted();
          const pendingPayloads = await listSourceChapterRenumberJournals(work.id);
          for (const payload of pendingPayloads) {
            await finishSourceChapterRenumber(
              parseSourceChapterRenumberJournal(payload),
            );
          }
          if (!input.isCurrent()) return publish(null);
          // Capture the published baseline, not a file that still has queued metadata edits.
          const flushed = await flushAndReadRenumberWork(work);
          const currentChanges = plan(flushed.work, flushed.storedChapters);
          if (!currentChanges.length) return publish(null);
          const configuredServer = !serverMappings
            ? useContentSyncStore.getState().serverUrl ||
              (await readServerNovelSource(flushed.work.id))?.serverUrl ||
              ""
            : "";
          const journal = await createSourceChapterRenumberJournal(
            flushed.work,
            currentChanges,
            configuredServer
              ? normalizeContentServerUrl(configuredServer)
              : null,
            coverWrites,
            flushed.metadataFingerprint,
          );
          const finish = async () => {
            const persisted = await readSourceChapterRenumberJournal(
              journal.operationId,
            );
            if (persisted) await finishSourceChapterRenumber(persisted);
          };
          let result: T;
          try {
            if (isTauriRuntime()) {
              const preparation = await prepareChapterStorageTransfer(
                journal.changes.map((change) => ({
                  entryId: String(change.id),
                  sourceRelativeDir: change.sourceRelativeDir,
                  targetRelativeDir: change.targetRelativeDir,
                })),
                { token: journal.operationId, requireEmptyTargets: true },
              );
              validateRenumberPreparation(journal, preparation);
              journal.preparation = preparation;
              await saveSourceChapterRenumberJournal(journal);
            }
            input.signal?.throwIfAborted();
            result = await publish(journal);
          } catch (error) {
            try {
              await finish();
            } catch (recoveryError) {
              throw new AggregateError(
                [error, recoveryError],
                "Chapter number reconciliation needs recovery. Both file copies were retained.",
              );
            }
            throw error;
          }
          await finish();
          return result;
        });
      },
    );
  return serverMappings ? operation() : runContentSyncOperation(operation);
}
