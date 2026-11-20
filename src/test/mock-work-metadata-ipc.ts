import type { TestSqliteDatabase as Database } from "./sql/types";
import { base64ToBytes } from "../lib/base64";
import { currentChapterDownloadRevision } from "../lib/chapter-download-writes";
import { reconcileImportedNovelIdentityInDb } from "./sql/novel-identity";
import { mergeIncomingNovelMetadata } from "../lib/work-metadata/merge";
import { createChapterIpcHandler } from "./mock-chapter-ipc";
import {
  applySourceChapterNumberChangesInDb,
  commitSourceChapterRenumberInDb,
  readRenumberChaptersInDb,
} from "./mock-novel-merge-ipc";
import {
  availableNovelMetadataDirectory,
  discoverStoredNovelCover,
  parseNovelMetadata,
  readStoredNovelCover,
  readStoredNovelMetadata,
  registerNativeWorkChapterDirectories,
  removeStoredNovelCover,
  setWorkMetadataRollbackGuard,
  withWorkMetadataRollback,
  workMetadataOperation,
  writeStoredNovelCover,
  writeStoredNovelMetadata,
  type NovelMetadataV1,
  type StoredNovelChapter,
  type StoredNovelNumberReconciliation,
} from "../lib/work-metadata";
import { coverOverrideInDb, overridePayloadsInDb, statusOverrideInDb } from "./sql/novel-override";
import { sqliteBoolean } from "./sql/sqlite-value";
import { stableCategoryIdInDb } from "./sql/user-state-core";
import type { DbMutationEffects, DbMutationEnvelope } from "../db/ipc";
import {
  applyNovelMetadataToCache,
  flushWorkMetadata,
  hasWorkMetadataConflict,
  initializeWorkMetadata,
  knownNovelMetadataDirectory,
  rememberStoredNovelMetadata,
  restoreWorkMetadataDirectories,
  scanStoredNovelChaptersToCache,
  type WorkMetadataRecoveryProgress,
  type WorkMetadataSyncFile,
} from "./sql/work-metadata";

export interface WorkMetadataIpcBridgeOptions {
  getDb: () => Database | Promise<Database>;
  runTransaction: <T>(
    run: (db: Database) => Promise<T>,
    remoteContentSync?: boolean,
  ) => Promise<T>;
  runRecoveryTransaction?: <T>(
    db: Database,
    run: (transaction: Database) => Promise<T>,
  ) => Promise<T>;
  runExclusive?: <T>(run: () => Promise<T>) => Promise<T>;
  emitRecoveryEvent?: (payload: {
    progress: WorkMetadataRecoveryProgress;
    effects?: DbMutationEffects | null;
  }) => void;
}

function hasWorkIdentity(
  value: unknown,
  expected: NovelMetadataV1["identity"],
): boolean {
  if (!value || typeof value !== "object" || !("identity" in value)) return false;
  const identity = (value as { identity?: Record<string, unknown> }).identity;
  return Boolean(
    identity &&
      identity.pluginId === expected.pluginId &&
      identity.novelPath === expected.novelPath &&
      identity.novelId === expected.novelId,
  );
}

async function readMetadataForReplacement(
  directory: string,
  expected: NovelMetadataV1["identity"],
): Promise<{ directory: string; metadata: NovelMetadataV1 } | null> {
  const { body } = await workMetadataOperation({
    operation: "read",
    path: `${directory}/novel.json`,
  });
  if (!body) return null;
  const raw: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
  if (!hasWorkIdentity(raw, expected)) {
    throw new Error(
      "work metadata: replacement identity does not match the existing file",
    );
  }
  const metadata = parseNovelMetadata(raw);
  metadata.cover = await discoverStoredNovelCover(directory, metadata.cover);
  return { directory, metadata };
}

async function removeAllCovers(
  directory: string,
  preferred: NovelMetadataV1["cover"],
): Promise<void> {
  let cover = await discoverStoredNovelCover(directory, preferred);
  const removed = new Set<string>();
  while (cover) {
    if (removed.has(cover.fileName)) {
      throw new Error("work metadata: cleared cover is still present");
    }
    removed.add(cover.fileName);
    await removeStoredNovelCover(directory, cover, false);
    cover = await discoverStoredNovelCover(directory);
  }
}

export function createWorkMetadataIpcHandler(
  options: WorkMetadataIpcBridgeOptions,
) {
  let recoveryController: AbortController | null = null;
  const chapterIpc = createChapterIpcHandler({
    getDb: options.getDb,
    runTransaction: options.runTransaction,
  });

  return {
    cancelRecovery(): void {
      recoveryController?.abort();
      recoveryController = null;
    },
    async handle(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<{ handled: true; result: unknown } | { handled: false }> {
      const chapterHandled = await chapterIpc.handle(command, args);
      if (chapterHandled.handled) return chapterHandled;
      if (command === "db_work_metadata_cancel_recovery") {
        recoveryController?.abort();
        recoveryController = null;
        return { handled: true, result: null };
      }

      if (command === "db_work_metadata_restore_directories") {
        const db = await options.getDb();
        const files = await db.select<
          Array<{
            pluginId: string;
            path: string;
            novelId: number;
            directory: string;
            fingerprint: string;
          }>
        >(
          "SELECT plugin_id AS pluginId,path,novel_id AS novelId,directory,fingerprint FROM work_metadata_file_cache",
        );
        const chapters = await db.select<
          Array<{ id: number; directory: string }>
        >(
          "SELECT chapter_id AS id,directory FROM work_metadata_directory_cache ORDER BY chapter_id",
        );
        if (args.registerNative) {
          await registerNativeWorkChapterDirectories({}, true);
          for (let offset = 0; offset < chapters.length; offset += 1000) {
            const batch = chapters.slice(offset, offset + 1000);
            await registerNativeWorkChapterDirectories(
              Object.fromEntries(
                batch.map((chapter) => [String(chapter.id), chapter.directory]),
              ),
            );
          }
        }
        return { handled: true, result: { files, chapters } };
      }

      if (command === "db_work_metadata_get_work_directory") {
        const db = await options.getDb();
        const [work] = await db.select<Array<{ directory: string }>>(
          "SELECT directory FROM work_metadata_file_cache WHERE novel_id=$1",
          [args.novelId],
        );
        return { handled: true, result: work?.directory ?? null };
      }

      if (command === "db_work_metadata_apply_scanned_downloads") {
        const novelId = args.novelId as number;
        const directory = args.directory as string;
        const chapters = (args.chapters ?? []) as StoredNovelChapter[];
        const skipped = new Set<number>(
          (args.skippedChapterIds as number[] | undefined) ?? [],
        );
        await options.runTransaction(async (transaction) => {
          const [current] = await transaction.select<
            Array<{ directory: string }>
          >(
            "SELECT f.directory FROM work_metadata_file_cache f JOIN novel n ON n.id=f.novel_id WHERE n.id=$1",
            [novelId],
          );
          if (current?.directory !== directory) return;
          await scanStoredNovelChaptersToCache(
            transaction,
            novelId,
            directory,
            {
              chapters,
              downloadRevision: currentChapterDownloadRevision(),
              skippedChapterIds: skipped,
            },
          );
        });
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_work_metadata_flush_pending") {
        const db = await options.getDb();
        const [pending] = await db.select<Array<{ pending: number }>>(
          "SELECT 1 AS pending FROM work_metadata_dirty LIMIT 1",
        );
        if (pending) {
          await options.runTransaction(async (transaction) => {
            await flushWorkMetadata(transaction);
          });
        }
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_work_metadata_rescan_work") {
        const directory = args.directory as string;
        const chapters = (args.chapters ?? []) as StoredNovelChapter[];
        const skipped = new Set<number>(
          (args.skippedChapterIds as number[] | undefined) ?? [],
        );
        await options.runTransaction(async (transaction) => {
          const current = await readStoredNovelMetadata(directory);
          if (!current) return;
          const fileConflict = await hasWorkMetadataConflict(
            current.directory,
            current.metadata,
          );
          const [existing] = fileConflict
            ? await transaction.select<Array<{ id: number }>>(
                "SELECT id FROM novel WHERE plugin_id=$1 AND path=$2",
                [
                  current.metadata.identity.pluginId,
                  current.metadata.identity.novelPath,
                ],
              )
            : [];
          if (fileConflict && !existing) return;
          const novelId =
            existing?.id ??
            (await applyNovelMetadataToCache(
              transaction,
              current.metadata,
              current.directory,
              { preserveMissingMetadata: true },
            ));
          await scanStoredNovelChaptersToCache(
            transaction,
            novelId,
            current.directory,
            {
              chapters,
              downloadRevision: currentChapterDownloadRevision(),
              skippedChapterIds: skipped,
            },
          );
          if (!fileConflict) {
            await rememberStoredNovelMetadata(
              transaction,
              current.directory,
              current.metadata,
              true,
            );
          }
          await transaction.execute(
            "DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2",
            [
              current.metadata.identity.pluginId,
              current.metadata.identity.novelPath,
            ],
          );
        }, true);
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_work_metadata_read_sync_files") {
        const db = await options.getDb();
        const [pending] = await db.select<Array<{ pending: number }>>(
          "SELECT 1 AS pending FROM work_metadata_dirty LIMIT 1",
        );
        if (pending) {
          await options.runTransaction(async (transaction) => {
            await flushWorkMetadata(transaction);
          });
        }
        const rows = await db.select<WorkMetadataSyncFile[]>(
          `SELECT f.plugin_id AS pluginId,f.path,f.directory,f.fingerprint,COALESCE(j.revision,0) AS revision
           FROM work_metadata_file_cache f LEFT JOIN work_metadata_sync_journal j ON j.plugin_id=f.plugin_id AND j.path=f.path`,
        );
        return {
          handled: true,
          result: { value: rows, effects: {} } satisfies DbMutationEnvelope<
            WorkMetadataSyncFile[]
          >,
        };
      }

      if (command === "db_work_metadata_read_sync_file") {
        const db = await options.getDb();
        const [file] = await db.select<WorkMetadataSyncFile[]>(
          `SELECT f.plugin_id AS pluginId,f.path,f.directory,f.fingerprint,COALESCE(j.revision,0) AS revision
           FROM work_metadata_file_cache f LEFT JOIN work_metadata_sync_journal j ON j.plugin_id=f.plugin_id AND j.path=f.path
           WHERE f.plugin_id=$1 AND f.path=$2`,
          [args.pluginId, args.novelPath],
        );
        return { handled: true, result: file ?? null };
      }

      if (command === "db_work_metadata_persist_cover") {
        const directory = args.directory as string;
        const cover = (args.cover ?? null) as {
          body: number[];
          fileName: string;
          contentType: string | null;
        } | null;
        const preserveExisting = Boolean(args.preserveExisting);
        const identity = await options.runTransaction((db) =>
          withWorkMetadataRollback(
            async () => {
              if (preserveExisting) {
                const { cover: existing } = await workMetadataOperation({
                  operation: "cover",
                  path: `${directory}/novel.json`,
                });
                if (existing) return null;
              }
              const { body } = await workMetadataOperation({
                operation: "read",
                path: `${directory}/novel.json`,
              });
              if (!body) throw new Error("work metadata: missing work for cover");
              const metadata = parseNovelMetadata(
                JSON.parse(new TextDecoder().decode(base64ToBytes(body))),
              );
              metadata.cover = await discoverStoredNovelCover(
                directory,
                metadata.cover,
              );
              if (await hasWorkMetadataConflict(directory, metadata)) {
                throw new Error(
                  "work metadata: file changed outside the cache; refresh from the source before editing",
                );
              }
              let coverChanged = false;
              if (cover) {
                const previousCover = metadata.cover;
                metadata.cover = {
                  fileName: cover.fileName,
                  contentType: cover.contentType,
                };
                coverChanged = await writeStoredNovelCover(
                  directory,
                  metadata,
                  new Uint8Array(cover.body),
                  false,
                );
                if (
                  previousCover &&
                  previousCover.fileName !== cover.fileName
                ) {
                  await removeStoredNovelCover(directory, previousCover, false);
                }
              } else {
                const removed = new Set<string>();
                while (metadata.cover) {
                  if (removed.has(metadata.cover.fileName)) {
                    throw new Error(
                      "work metadata: cleared cover is still present",
                    );
                  }
                  removed.add(metadata.cover.fileName);
                  await removeStoredNovelCover(
                    directory,
                    metadata.cover,
                    false,
                  );
                  coverChanged = true;
                  metadata.cover = await discoverStoredNovelCover(directory);
                }
              }
              await writeStoredNovelMetadata(directory, metadata, false);
              await rememberStoredNovelMetadata(
                db,
                directory,
                metadata,
                coverChanged,
              );
              return metadata.identity;
            },
            { preserveCoverSourcesOnRollback: preserveExisting },
          ),
        );
        const effects: DbMutationEffects = identity
          ? {
              workMetadataChanged: true,
              workDirectories: [
                {
                  novelId: 0,
                  pluginId: identity.pluginId,
                  novelPath: identity.novelPath,
                  directory,
                },
              ],
            }
          : {};
        if (identity) {
          const db = await options.getDb();
          const [cached] = await db.select<
            Array<{ novelId: number; fingerprint: string }>
          >(
            "SELECT novel_id AS novelId, fingerprint FROM work_metadata_file_cache WHERE plugin_id=$1 AND path=$2",
            [identity.pluginId, identity.novelPath],
          );
          if (cached && effects.workDirectories?.[0]) {
            effects.workDirectories[0].novelId = cached.novelId;
            effects.workDirectories[0].fingerprint = cached.fingerprint;
          }
        }
        return {
          handled: true,
          result: { value: identity, effects } satisfies DbMutationEnvelope<
            NovelMetadataV1["identity"] | null
          >,
        };
      }

      if (command === "db_work_metadata_inspect_install") {
        const identity = args.identity as NovelMetadataV1["identity"];
        const directory =
          knownNovelMetadataDirectory(identity) ??
          (await availableNovelMetadataDirectory({
            identity,
            novel: {
              name: identity.novelId,
              author: null,
              artist: null,
              summary: null,
              status: null,
              genres: null,
              rating: null,
              isLocal: identity.pluginId === "local",
            },
          }));
        const existing = await readMetadataForReplacement(directory, identity);
        return {
          handled: true,
          result: { directory, existing },
        };
      }

      if (command === "db_work_metadata_reindex_preserved_work") {
        const input = args.input as {
          directory: string;
          metadata: NovelMetadataV1;
        };
        const metadata = parseNovelMetadata(input.metadata);
        const novelId = await options.runTransaction(async (db) => {
          const id = await applyNovelMetadataToCache(
            db,
            metadata,
            input.directory,
          );
          await scanStoredNovelChaptersToCache(db, id, input.directory);
          await rememberStoredNovelMetadata(db, input.directory, metadata);
          await db.execute(
            "DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2",
            [metadata.identity.pluginId, metadata.identity.novelPath],
          );
          return id;
        }, true);
        return {
          handled: true,
          result: {
            value: novelId,
            effects: {},
          } satisfies DbMutationEnvelope<number>,
        };
      }

      if (command === "db_work_metadata_install_stored") {
        const input = args.input as {
          metadata: NovelMetadataV1;
          coverBytes?: number[] | null;
          authoritative?: boolean;
          preserveLocalCover?: boolean;
          reconciliation?: StoredNovelNumberReconciliation | null;
        };
        let metadata = parseNovelMetadata(input.metadata);
        const coverBytes = input.coverBytes?.length
          ? new Uint8Array(input.coverBytes)
          : undefined;
        const authoritative = Boolean(input.authoritative);
        const preserveLocalCover = Boolean(input.preserveLocalCover);
        const reconciliation = input.reconciliation ?? undefined;
        if (
          authoritative &&
          !preserveLocalCover &&
          metadata.cover &&
          !coverBytes?.length
        ) {
          throw new Error(
            "A migration target cover requires verified cover bytes.",
          );
        }
        const preferred =
          knownNovelMetadataDirectory(metadata.identity) ??
          (await availableNovelMetadataDirectory(metadata));
        const installed = await options.runTransaction(async (db) => {
          const directory =
            knownNovelMetadataDirectory(metadata.identity) ?? preferred;
          const existing = await readMetadataForReplacement(
            directory,
            metadata.identity,
          );
          return withWorkMetadataRollback(async () => {
            let previous = existing?.metadata;
            if (reconciliation) {
              const renumber = await import("../lib/source-chapter-renumber");
              renumber.assertChapterNumberMappings(reconciliation.mappings);
              const [work] = await db.select<
                import("../lib/source-chapter-renumber").RenumberWork[]
              >(
                "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE plugin_id=$1 AND path=$2",
                [metadata.identity.pluginId, metadata.identity.novelPath],
              );
              if (!work || work.sourceNovelId !== metadata.identity.novelId) {
                throw new Error("Incoming chapter number identity changed.");
              }
              const currentChapters = await readRenumberChaptersInDb(
                db,
                work.id,
              );
              const changes = renumber.planServerChapterNumberChanges(
                work,
                currentChapters,
                reconciliation.mappings,
              );
              if (reconciliation.journal) {
                if (
                  JSON.stringify(changes) !==
                  JSON.stringify(reconciliation.journal.changes)
                ) {
                  throw new Error(
                    "Local chapter state changed while the server correction was prepared.",
                  );
                }
                await renumber.assertSourceChapterRenumberMetadataUnchanged(
                  reconciliation.journal,
                );
                const journal = reconciliation.journal;
                for (const file of journal.metadataFiles ?? []) {
                  setWorkMetadataRollbackGuard(file.path, () =>
                    renumber.assertSourceChapterRenumberMetadataRecoverable(
                      journal,
                    ),
                  );
                }
                await applySourceChapterNumberChangesInDb(db, work.id, journal);
              } else if (changes.length) {
                throw new Error(
                  "Incoming chapter numbers changed before their storage could be prepared.",
                );
              }
              const chapters = { ...previous?.chapters };
              for (const mapping of reconciliation.mappings) {
                delete chapters[mapping.from];
                if (Object.hasOwn(metadata.chapters, mapping.from)) {
                  throw new Error(
                    "Incoming catalog still contains a replaced chapter number.",
                  );
                }
              }
              if (previous) previous = { ...previous, chapters };
              await reconcileImportedNovelIdentityInDb(
                db,
                {
                  pluginId: metadata.identity.pluginId,
                  path: metadata.identity.novelPath,
                },
                reconciliation.mappings.map((mapping) => ({
                  path: mapping.chapterPath,
                  chapterNumber: mapping.to,
                })),
              );
            }
            const merged = mergeIncomingNovelMetadata(previous, metadata);
            metadata = authoritative
              ? { ...merged, novel: metadata.novel, cover: metadata.cover }
              : merged;
            if (authoritative && !preserveLocalCover) {
              await removeAllCovers(
                directory,
                existing?.metadata.cover ?? null,
              );
            }
            if (coverBytes) {
              await writeStoredNovelCover(
                directory,
                metadata,
                coverBytes,
                false,
              );
            } else if (!authoritative || preserveLocalCover) {
              metadata.cover = existing?.metadata.cover ?? null;
            }
            const installedNovelId = await applyNovelMetadataToCache(
              db,
              metadata,
              directory,
              { preserveMissingMetadata: !authoritative },
            );
            if (
              authoritative &&
              !preserveLocalCover &&
              !metadata.novel.isLocal
            ) {
              await db.execute("UPDATE novel SET cover=NULL WHERE id=$1", [
                installedNovelId,
              ]);
            }
            const [cached] = await db.select<
              Array<
                Pick<
                  NovelMetadataV1["novel"],
                  "author" | "artist" | "summary" | "status" | "genres" | "rating"
                >
              >
            >(
              "SELECT author,artist,summary,status,genres,rating FROM novel WHERE id=$1",
              [installedNovelId],
            );
            if (!cached) {
              throw new Error(
                "Installed work metadata is missing from the local cache.",
              );
            }
            metadata.novel = { ...metadata.novel, ...cached };
            await writeStoredNovelMetadata(directory, metadata, false);
            await db.execute(
              "DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2",
              [metadata.identity.pluginId, metadata.identity.novelPath],
            );
            await rememberStoredNovelMetadata(db, directory, metadata, true);
            const [syncFile] = await db.select<WorkMetadataSyncFile[]>(
              `SELECT f.plugin_id AS pluginId,f.path,f.directory,f.fingerprint,COALESCE(j.revision,0) AS revision
               FROM work_metadata_file_cache f LEFT JOIN work_metadata_sync_journal j ON j.plugin_id=f.plugin_id AND j.path=f.path
               WHERE f.plugin_id=$1 AND f.path=$2`,
              [metadata.identity.pluginId, metadata.identity.novelPath],
            );
            if (!syncFile) {
              throw new Error(
                "Installed work metadata is missing from the local index.",
              );
            }
            if (reconciliation?.journal) {
              await commitSourceChapterRenumberInDb(db, reconciliation.journal);
            }
            const storedCover = await readStoredNovelCover(directory, metadata);
            return {
              novelId: installedNovelId,
              directory,
              metadata,
              syncFile,
              coverBytes: storedCover ? Array.from(storedCover) : null,
            };
          });
        }, true);
        const effects: DbMutationEffects = installed
          ? {
              coverChangedNovelIds: [installed.novelId],
              workDirectories: [
                {
                  novelId: installed.novelId,
                  pluginId: installed.metadata.identity.pluginId,
                  novelPath: installed.metadata.identity.novelPath,
                  directory: installed.directory,
                  fingerprint: installed.syncFile.fingerprint,
                },
              ],
            }
          : {};
        return {
          handled: true,
          result: { value: installed, effects },
        };
      }

      if (command === "db_startup_recover_work_metadata") {
        recoveryController?.abort();
        const controller = new AbortController();
        recoveryController = controller;
        const db = await options.getDb();
        let latestProgress: WorkMetadataRecoveryProgress = {
          totalWorks: 0,
          completedWorks: 0,
          recoveredWorks: 0,
          recoveredChapters: 0,
          skippedWorks: 0,
          currentWork: null,
        };
        try {
          await initializeWorkMetadata(db, {
            rebuild: Boolean(args.rebuild),
            signal: controller.signal,
            runExclusive: options.runExclusive,
            runTransaction:
              options.runRecoveryTransaction ??
              ((_rawDb, run) => options.runTransaction(run, false)),
            onProgress: (progress) => {
              if (controller.signal.aborted) return;
              latestProgress = progress;
              options.emitRecoveryEvent?.({ progress });
            },
          });
        } catch (error) {
          if (recoveryController === controller) {
            recoveryController = null;
          }
          await restoreWorkMetadataDirectories(db, false).catch(() => undefined);
          throw error;
        }
        if (recoveryController === controller) {
          recoveryController = null;
        }
        return {
          handled: true,
          result: {
            value: latestProgress,
            effects: {},
          } satisfies DbMutationEnvelope<WorkMetadataRecoveryProgress>,
        };
      }

      if (
        command === "db_novel_list_library" ||
        command === "db_novel_list_library_page" ||
        command === "db_novel_get_library_summary"
      ) {
        const db = await options.getDb();
        const filter = ((args.filter ?? {}) as {
          search?: string;
          categoryId?: number | null;
          downloadedOnly?: boolean;
          repairNeededOnly?: boolean;
          sourceId?: string | null;
          unreadOnly?: boolean;
          localOnly?: boolean;
          completedOnly?: boolean;
          limit?: number;
        });
        const storedSql = `(COALESCE(s.chapters_downloaded, 0) + (
          SELECT COUNT(*) FROM chapter stored
          WHERE stored.novel_id = n.id AND stored.is_downloaded = 0 AND stored.content_bytes > 0
        ))`;
        const params: unknown[] = [];
        const addParam = (v: unknown) => {
          params.push(v);
          return `$${params.length}`;
        };
        const conditions: string[] = ["n.in_library = 1"];
        const trimmed = filter.search?.trim() ?? "";
        if (trimmed) conditions.push(`n.name LIKE '%' || ${addParam(trimmed)} || '%' COLLATE NOCASE`);
        if (filter.categoryId === -1) {
          conditions.push("NOT EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id)");
        } else if (filter.categoryId != null) {
          conditions.push(`EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id AND nc.category_id = ${addParam(filter.categoryId)})`);
        }
        if (filter.downloadedOnly) conditions.push(`(n.is_local = 1 OR ${storedSql} > 0)`);
        if (filter.repairNeededOnly) conditions.push("EXISTS (SELECT 1 FROM chapter c WHERE c.novel_id = n.id AND c.media_repair_needed = 1)");
        if (filter.sourceId?.trim()) conditions.push(`n.plugin_id = ${addParam(filter.sourceId.trim())}`);
        if (filter.unreadOnly) conditions.push("COALESCE(s.chapters_unread, 0) > 0");
        if (filter.localOnly) conditions.push(`n.plugin_id = ${addParam("local")} AND n.is_local = 1`);
        if (filter.completedOnly) conditions.push("COALESCE(s.total_chapters, 0) > 0 AND COALESCE(s.chapters_unread, 0) = 0");

        const cte = `WITH library_rows AS (
          SELECT
            n.id,
            n.plugin_id AS pluginId,
            ip.name AS pluginName,
            n.source_novel_id AS sourceNovelId,
            n.path,
            n.name,
            n.cover,
            n.author,
            n.in_library AS inLibrary,
            n.is_local AS isLocal,
            COALESCE(s.total_chapters, 0) AS totalChapters,
            ${storedSql} AS chaptersDownloaded,
            COALESCE(s.chapters_unread, 0) AS chaptersUnread,
            COALESCE(s.reading_progress, 0) AS readingProgress,
            n.last_read_at AS lastReadAt,
            CASE WHEN COALESCE(s.total_chapters, 0) > 0 THEN COALESCE(s.last_chapter_updated_at, n.updated_at) ELSE n.updated_at END AS lastUpdatedAt
          FROM novel n
          LEFT JOIN novel_stats s ON s.novel_id = n.id
          LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
          WHERE ${conditions.join(" AND ")}
        )`;

        if (command === "db_novel_get_library_summary") {
          const [row] = await db.select<Array<Record<string, number | null>>>(
            `${cte}
             SELECT
               COUNT(*) AS totalNovels,
               COALESCE(SUM(totalChapters), 0) AS totalChapters,
               COALESCE(SUM(chaptersDownloaded), 0) AS downloadedChapters,
               COALESCE(SUM(chaptersUnread), 0) AS unreadChapters,
               MAX(lastUpdatedAt) AS lastUpdatedAt,
               COALESCE(SUM(CASE WHEN chaptersUnread > 0 THEN 1 ELSE 0 END), 0) AS unreadNovels,
               COALESCE(SUM(CASE WHEN isLocal = 1 OR chaptersDownloaded > 0 THEN 1 ELSE 0 END), 0) AS downloadedNovels,
               COALESCE(SUM(CASE WHEN pluginId = 'local' AND isLocal = 1 THEN 1 ELSE 0 END), 0) AS localNovels,
               COALESCE(SUM(CASE WHEN totalChapters > 0 AND chaptersUnread = 0 THEN 1 ELSE 0 END), 0) AS completeNovels,
               COALESCE(SUM(EXISTS (SELECT 1 FROM chapter c WHERE c.novel_id = library_rows.id AND c.media_repair_needed = 1)), 0) AS repairNeededNovels
             FROM library_rows`,
            params,
          );
          return {
            handled: true,
            result: {
              completeNovels: row?.completeNovels ?? 0,
              downloadedChapters: row?.downloadedChapters ?? 0,
              downloadedNovels: row?.downloadedNovels ?? 0,
              lastUpdatedAt: row?.lastUpdatedAt ?? null,
              localNovels: row?.localNovels ?? 0,
              repairNeededNovels: row?.repairNeededNovels ?? 0,
              totalChapters: row?.totalChapters ?? 0,
              totalNovels: row?.totalNovels ?? 0,
              unreadChapters: row?.unreadChapters ?? 0,
              unreadNovels: row?.unreadNovels ?? 0,
            },
          };
        }

        const pageLimit = filter.limit ?? 100;
        const rawRows = await db.select<Array<Record<string, unknown>>>(
          `${cte} SELECT * FROM library_rows ORDER BY id DESC`,
          params,
        );
        const mapped = rawRows.map(row => {
          const isLocal = row.pluginId === "local" && Boolean(row.isLocal);
          return {
            ...row,
            inLibrary: Boolean(row.inLibrary),
            isLocal,
          };
        });
        if (command === "db_novel_list_library") {
          return {
            handled: true,
            result: filter.limit !== undefined ? mapped.slice(0, filter.limit) : mapped,
          };
        }
        const novels = mapped.slice(0, pageLimit);
        const hasMore = mapped.length > pageLimit;
        const last = novels.at(-1) as { id: number; name: string } | undefined;
        return {
          handled: true,
          result: {
            hasMore,
            nextCursor: hasMore && last ? { id: last.id, name: last.name, sortValue: last.id } : null,
            novels,
          },
        };
      }

      if (command === "db_novel_freshness_record_cover_fetched") {
        const db = await options.getDb();
        await db.execute(
          `INSERT INTO novel_freshness(novel_id,cover_fetched_at)
           SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM novel WHERE id=$1)
           ON CONFLICT(novel_id) DO UPDATE SET cover_fetched_at=excluded.cover_fetched_at`,
          [args.novelId, args.nowSeconds],
        );
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_novel_get_by_id" || command === "db_novel_find_by_source") {
        const db = await options.getDb();
        const [row] = await db.select<Array<Record<string, unknown>>>(
          command === "db_novel_get_by_id"
            ? `SELECT n.id, n.source_novel_id AS sourceNovelId, n.plugin_id AS pluginId, ip.name AS pluginName,
                      n.path, n.name, n.cover, n.summary, n.author, n.artist, n.status, n.genres, n.rating,
                      n.in_library AS inLibrary, n.is_local AS isLocal, n.created_at AS createdAt,
                      n.updated_at AS updatedAt, n.library_added_at AS libraryAddedAt, n.last_read_at AS lastReadAt
               FROM novel n LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id WHERE n.id = $1`
            : `SELECT n.id, n.source_novel_id AS sourceNovelId, n.plugin_id AS pluginId, ip.name AS pluginName,
                      n.path, n.name, n.cover, n.summary, n.author, n.artist, n.status, n.genres, n.rating,
                      n.in_library AS inLibrary, n.is_local AS isLocal, n.created_at AS createdAt,
                      n.updated_at AS updatedAt, n.library_added_at AS libraryAddedAt, n.last_read_at AS lastReadAt
               FROM novel n LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
               WHERE n.plugin_id = $1 AND n.path = $2`,
          command === "db_novel_get_by_id" ? [args.id] : [args.pluginId, args.path],
        );
        return {
          handled: true,
          result: row
            ? {
                ...row,
                inLibrary: Boolean(row.inLibrary),
                isLocal: row.pluginId === "local" && Boolean(row.isLocal),
                statusOverride: await statusOverrideInDb(db, row.id),
                coverOverride: await coverOverrideInDb(db, row.id),
              }
            : null,
        };
      }

      if (command === "backup_list_cached_chapter_directories") {
        const db = await options.getDb();
        const rows = await db.select<Array<Record<string, unknown>>>(
          `SELECT n.plugin_id AS pluginId, n.path AS novelPath, c.path AS chapterPath, d.directory,
                  c.stored_content_type AS storedContentType, c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes
           FROM work_metadata_directory_cache d
           JOIN chapter c ON c.id = d.chapter_id
           JOIN novel n ON n.id = c.novel_id`,
        );
        return { handled: true, result: rows };
      }

      if (command === "backup_gather_snapshot") {
        const result = await options.runTransaction(async (db) => {
          const [
            novels,
            chapters,
            categories,
            novelCategories,
            repositories,
            installedPlugins,
            vpnGateServerVerdicts,
            downloadGoals,
          ] = await Promise.all([
            db.select<Array<Record<string, unknown>>>(
              `SELECT id, plugin_id AS pluginId, source_novel_id AS sourceNovelId, path, name, cover, summary,
                      author, artist, status, genres, in_library AS inLibrary, is_local AS isLocal,
                      created_at AS createdAt, updated_at AS updatedAt, library_added_at AS libraryAddedAt,
                      last_read_at AS lastReadAt,
                      (SELECT payload FROM novel_chapter_composition WHERE novel_id = novel.id) AS chapterCompositionPayload
               FROM novel ORDER BY id`,
            ),
            db.select<Array<Record<string, unknown>>>(
              `SELECT id, novel_id AS novelId, path, name, chapter_number AS chapterNumber, position, page,
                      bookmark, progress, is_downloaded AS isDownloaded, content_type AS sourceContentType,
                      stored_content_type AS storedContentType, content_bytes AS contentBytes, media_bytes AS mediaBytes,
                      release_time AS releaseTime, read_at AS readAt, created_at AS createdAt, found_at AS foundAt,
                      found_by_check AS foundByCheck, updated_at AS updatedAt
               FROM chapter ORDER BY id`,
            ),
            db.select<Array<{ id: number; name: string; sort: number; isSystem: number }>>(
              `SELECT id, name, sort, is_system AS isSystem FROM category ORDER BY id`,
            ),
            db.select<Array<Record<string, unknown>>>(
              `SELECT id, novel_id AS novelId, category_id AS categoryId FROM novel_category ORDER BY id`,
            ),
            db.select<Array<Record<string, unknown>>>(
              `SELECT id, url, name, added_at AS addedAt, priority, enabled FROM repository ORDER BY priority, id`,
            ),
            db.select<Array<Record<string, unknown>>>(
              `SELECT id, name, lang, version, icon_url AS iconUrl, source_url AS sourceUrl,
                      source_code AS sourceCode, installed_at AS installedAt, repository_url AS repositoryUrl
               FROM installed_plugin ORDER BY installed_at DESC, id ASC`,
            ),
            db.select<Array<Record<string, unknown>>>(
              `SELECT ip, verdict, updated_at AS updatedAt FROM vpn_gate_server_verdict ORDER BY ip`,
            ),
            db.select<Array<Record<string, unknown>>>(
              `SELECT novel_id AS novelId, kind, count, updated_at AS updatedAt FROM novel_download_goal ORDER BY novel_id`,
            ),
          ]);
          const overridePayloads = await overridePayloadsInDb(db);
          const mappedCategories = [];
          for (const row of categories) {
            const isSystem = Boolean(row.isSystem);
            const stableId = isSystem ? null : await stableCategoryIdInDb(db, row.id);
            mappedCategories.push({
              id: row.id,
              name: row.name,
              sort: row.sort,
              isSystem,
              ...(stableId ? { stableId } : {}),
            });
          }
          return {
            novels: novels.map((row) => ({
              ...row,
              ...(overridePayloads.has(row.id as number)
                ? { overridePayload: overridePayloads.get(row.id as number) }
                : {}),
              inLibrary: sqliteBoolean(row.inLibrary),
              isLocal: row.pluginId === "local" && sqliteBoolean(row.isLocal),
            })),
            chapters: chapters.map((row) => ({
              ...row,
              bookmark: sqliteBoolean(row.bookmark),
              isDownloaded: sqliteBoolean(row.isDownloaded),
              foundByCheck: sqliteBoolean(row.foundByCheck),
            })),
            categories: mappedCategories,
            novelCategories,
            repositories: repositories.map((row) => ({
              ...row,
              enabled: sqliteBoolean(row.enabled),
            })),
            installedPlugins,
            vpnGateServerVerdicts,
            downloadGoals,
          };
        });
        return { handled: true, result };
      }

      return { handled: false };
    },
  };
}
