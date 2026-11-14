import type Database from "@tauri-apps/plugin-sql";
import { base64ToBytes } from "../lib/base64";
import { currentChapterDownloadRevision } from "../lib/chapter-download-writes";
import { mergeIncomingNovelMetadata } from "../lib/work-metadata/merge";
import {
  availableNovelMetadataDirectory,
  discoverStoredNovelCover,
  parseNovelMetadata,
  readStoredNovelCover,
  readStoredNovelMetadata,
  registerNativeWorkChapterDirectories,
  removeStoredNovelCover,
  withWorkMetadataRollback,
  workMetadataOperation,
  writeStoredNovelCover,
  writeStoredNovelMetadata,
  type NovelMetadataV1,
  type StoredNovelChapter,
} from "../lib/work-metadata";
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
} from "../db/work-metadata";

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

  return {
    cancelRecovery(): void {
      recoveryController?.abort();
      recoveryController = null;
    },
    async handle(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<{ handled: true; result: unknown } | { handled: false }> {
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

      if (command === "db_work_metadata_install_stored") {
        const input = args.input as {
          metadata: NovelMetadataV1;
          coverBytes?: number[] | null;
          authoritative?: boolean;
          preserveLocalCover?: boolean;
        };
        let metadata = parseNovelMetadata(input.metadata);
        const coverBytes = input.coverBytes?.length
          ? new Uint8Array(input.coverBytes)
          : undefined;
        const authoritative = Boolean(input.authoritative);
        const preserveLocalCover = Boolean(input.preserveLocalCover);
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
            const previous = existing?.metadata;
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

      return { handled: false };
    },
  };
}
