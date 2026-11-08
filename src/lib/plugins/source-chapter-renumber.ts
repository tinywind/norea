import { getDb, runDatabaseTransaction, runExclusiveDatabaseOperation } from "../../db/client";
import { flushWorkMetadata } from "../../db/work-metadata";
import { useContentSyncStore } from "../../store/content-sync";
import { prepareChapterStorageTransfer } from "../chapter-storage-transfer";
import { normalizeContentServerUrl } from "../content-sync/client";
import { runWorkContentStorageOperation } from "../content-sync/storage-operation";
import { runContentSyncOperation } from "../content-sync/sync";
import {
  SOURCE_CHAPTER_RENUMBER_PREFIX,
  createSourceChapterRenumberJournal,
  finishSourceChapterRenumberInDb,
  parseSourceChapterRenumberJournal,
  planSourceChapterNumberChanges,
  planServerChapterNumberChanges,
  readRenumberChapters,
  readSourceChapterRenumberJournal,
  saveSourceChapterRenumberJournal,
  validateRenumberPreparation,
  type RenumberWork,
  type ChapterNumberMapping,
  type ChapterRenumberCoverWrite,
  type StoredRenumberChapter,
  type SourceChapterRenumberJournal,
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
  return withChapterNumberReconciliation({ ...input, chapters: [], fullCatalog: true }, publish, input.mappings, input.coverWrite ? [input.coverWrite] : []);
}

async function withChapterNumberReconciliation<T>(
  input: SourceChapterReconciliationInput,
  publish: (journal: SourceChapterRenumberJournal | null) => Promise<T>,
  serverMappings?: readonly ChapterNumberMapping[],
  coverWrites: readonly ChapterRenumberCoverWrite[] = [],
): Promise<T> {
  const plan = (work: RenumberWork, chapters: readonly StoredRenumberChapter[]) => serverMappings
    ? planServerChapterNumberChanges(work, chapters, serverMappings)
    : planSourceChapterNumberChanges(work, chapters, input.chapters);
  const db = await getDb();
  const [work] = await db.select<RenumberWork[]>(
    "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE plugin_id=$1 AND path=$2",
    [input.pluginId, input.path],
  );
  const publishNormally = () => runWorkContentStorageOperation(input.pluginId, input.path, () => publish(null));
  if (!work || work.sourceNovelId !== input.sourceNovelId) return publishNormally();
  const pending = await db.select<{ payload: string }[]>(
    "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 AND json_extract(payload,'$.work.id')=$2",
    [SOURCE_CHAPTER_RENUMBER_PREFIX + "%", work.id],
  );
  const storedChapters = await readRenumberChapters(db, work.id);
  input.signal?.throwIfAborted();
  if (!input.isCurrent()) return publishNormally();
  const changes = plan(work, storedChapters);
  if (!changes.length && !pending.length) return publishNormally();
  if (!input.fullCatalog) throw new Error("Chapter numbers changed. Refresh the complete chapter list before continuing.");

  const operation = () => runExclusiveChapterStorageOperation(
    { kind: "sources", sourceIds: [input.pluginId] }, input.signal, async () => {
      await cancelNovelChapterDownloadWork([work.id]);
      return runWorkContentStorageOperation(input.pluginId, input.path, async () => {
        input.signal?.throwIfAborted();
        await runExclusiveDatabaseOperation(async transaction => {
          const journals = await transaction.select<{ payload: string }[]>(
            "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 AND json_extract(payload,'$.work.id')=$2",
            [SOURCE_CHAPTER_RENUMBER_PREFIX + "%", work.id],
          );
          for (const row of journals) await finishSourceChapterRenumberInDb(transaction, parseSourceChapterRenumberJournal(row.payload));
        }, { publishMetadata: false });
        if (!input.isCurrent()) return publish(null);
        const journal = await runDatabaseTransaction(async transaction => {
          const [current] = await transaction.select<RenumberWork[]>(
            "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1", [work.id],
          );
          if (!current || current.pluginId !== input.pluginId || current.path !== input.path || current.sourceNovelId !== input.sourceNovelId) {
            throw new Error("The work changed before its chapter numbers could be reconciled.");
          }
          const currentChanges = plan(current, await readRenumberChapters(transaction, current.id));
          if (!currentChanges.length) return null;
          // Capture the published baseline, not a file that still has queued metadata edits.
          await flushWorkMetadata(transaction);
          const configuredServer = useContentSyncStore.getState().serverUrl;
          return createSourceChapterRenumberJournal(transaction, current, currentChanges,
            !serverMappings && configuredServer ? normalizeContentServerUrl(configuredServer) : null, coverWrites);
        });
        if (!journal) return publish(null);
        const finish = () => runExclusiveDatabaseOperation(async transaction => {
          const persisted = await readSourceChapterRenumberJournal(transaction, journal.operationId);
          if (persisted) await finishSourceChapterRenumberInDb(transaction, persisted);
        }, { publishMetadata: false });
        let result: T;
        try {
          if (isTauriRuntime()) {
            const preparation = await prepareChapterStorageTransfer(journal.changes.map(change => ({
              entryId: String(change.id), sourceRelativeDir: change.sourceRelativeDir, targetRelativeDir: change.targetRelativeDir,
            })), { token: journal.operationId, requireEmptyTargets: true });
            validateRenumberPreparation(journal, preparation);
            journal.preparation = preparation;
            await runDatabaseTransaction(transaction => saveSourceChapterRenumberJournal(transaction, journal));
          }
          input.signal?.throwIfAborted();
          result = await publish(journal);
        } catch (error) {
          try { await finish(); }
          catch (recoveryError) {
            throw new AggregateError([error, recoveryError], "Chapter number reconciliation needs recovery. Both file copies were retained.");
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
