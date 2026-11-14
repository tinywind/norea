import type Database from "@tauri-apps/plugin-sql";
import type { DbMutationEnvelope } from "../db/ipc";
import { withChapterDownloadSnapshotReads } from "../lib/chapter-download-writes";
import {
  parseUserStateCurrentSnapshot,
  type UserStateCurrentApplyResult,
  type UserStateCurrentSnapshot,
  type UserStateCurrentStatus,
} from "../lib/user-state/current-types";
import {
  parsePortableReaderAnchor,
  userStateWorkKey,
  type PortableReaderAnchor,
  type UserStateApplyEffects,
  type UserStateBinding,
  type UserStateMergeResult,
  type UserStateOperation,
  type UserStateReadResponse,
  type UserStateRecord,
} from "../lib/user-state/types";
import {
  assertUserStateAvailableInDb,
  chapterReference,
  chapterWork,
  hasUserStateSchema,
  namespaceFor,
  recordResumeClearedInDb,
  recordUserStateChangesInDb,
  requestUserStateDeferredApply,
  requireBinding,
  USER_CHAPTER_SELECT,
  userStateRestorePausedInDb,
  workspaceRows,
  type UserChapterRow,
} from "../db/user-state-core";
import {
  applyCurrentSnapshotWithTransactionsInDb,
  buildCurrentSnapshotInDb,
  currentCacheKey,
  currentExportKey,
  loadCurrentDataInDb,
  type CurrentWork,
} from "../db/user-state-current-data";
import {
  acknowledgeUserStateOperationsInDb,
  applyUserStateReadPageInDb,
  bindUserStateWorkspaceInDb,
  getUserStateLedgerStatusInDb,
  listUserStateConflictsInDb,
  listUserStateDeferredInDb,
  prepareUserStateOperationsInDb,
  resolveUserStateLedgerConflictInDb,
  type UserStateLedgerStatus,
} from "../db/user-state-ledger";
import {
  listPendingUserStateProjectionRecordsInDb,
  projectUserStateRecordsInDb,
  refreshUnattemptedUserStateIdentitiesInDb,
} from "../db/user-state-materialize";

export interface UserStateIpcBridgeOptions {
  getDb: () => Database | Promise<Database>;
  runTransaction: <T>(
    run: (db: Database) => Promise<T>,
    remoteContentSync?: boolean,
  ) => Promise<T>;
  runExclusive?: <T>(run: (db: Database) => Promise<T>) => Promise<T>;
}

export function createUserStateIpcHandler(options: UserStateIpcBridgeOptions) {
  return {
    async handle(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<{ handled: true; result: unknown } | { handled: false }> {
      if (command === "db_user_state_set_current_mode") {
        return { handled: true, result: null };
      }

      if (command === "db_user_state_get_binding") {
        const serverUrl = (args.serverUrl ?? null) as string | null;
        if (!serverUrl) return { handled: true, result: null };
        const db = await options.getDb();
        if (!(await hasUserStateSchema(db))) {
          return { handled: true, result: null };
        }
        const rows = await workspaceRows(db);
        const row = rows.find(candidate => candidate.serverUrl === serverUrl);
        return {
          handled: true,
          result: row
            ? {
                serverUrl: row.serverUrl,
                workspaceId: row.workspaceId,
                epoch: row.epoch,
              }
            : null,
        };
      }

      if (command === "db_user_state_bind_workspace") {
        const binding = args.binding as UserStateBinding;
        await options.runTransaction(db =>
          bindUserStateWorkspaceInDb(db, binding),
        );
        return {
          handled: true,
          result: {
            value: null,
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_user_state_prepare_operations") {
        const binding = args.binding as UserStateBinding;
        const limits = args.limits as
          | {
              limit?: number;
              maxBytes?: number;
              allowOpaqueIdentity?: boolean;
            }
          | undefined;
        const operations = await options.runTransaction(async db => {
          await refreshUnattemptedUserStateIdentitiesInDb(db);
          return prepareUserStateOperationsInDb(db, binding, limits);
        });
        return {
          handled: true,
          result: {
            value: operations,
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<UserStateOperation[]>,
        };
      }

      if (command === "db_user_state_get_ledger_status") {
        const db = await options.getDb();
        const binding = (args.binding ?? null) as UserStateBinding | null;
        if (binding) {
          return {
            handled: true,
            result: await getUserStateLedgerStatusInDb(db, binding),
          };
        }
        if (!(await hasUserStateSchema(db))) {
          const status: UserStateLedgerStatus = {
            cursor: 0,
            through: null,
            pending: 0,
            conflicts: 0,
            deferred: 0,
            projectionPending: 0,
            projectionParked: 0,
            projectionFailed: 0,
            lastSuccessAt: null,
            pausedAfterRestore: await userStateRestorePausedInDb(db),
          };
          return { handled: true, result: status };
        }
        const [row] = await db.select<{ pending: number }[]>(
          "SELECT COUNT(*) AS pending FROM user_state_intent",
        );
        const status: UserStateLedgerStatus = {
          cursor: 0,
          through: null,
          pending: row?.pending ?? 0,
          conflicts: 0,
          deferred: 0,
          projectionPending: 0,
          projectionParked: 0,
          projectionFailed: 0,
          lastSuccessAt: null,
          pausedAfterRestore: await userStateRestorePausedInDb(db),
        };
        return { handled: true, result: status };
      }

      if (command === "db_user_state_list_conflicts") {
        const db = await options.getDb();
        return {
          handled: true,
          result: await listUserStateConflictsInDb(
            db,
            args.binding as UserStateBinding,
          ),
        };
      }

      if (command === "db_user_state_list_deferred") {
        const db = await options.getDb();
        return {
          handled: true,
          result: await listUserStateDeferredInDb(
            db,
            args.binding as UserStateBinding,
          ),
        };
      }

      if (command === "db_user_state_apply_read_page") {
        const binding = args.binding as UserStateBinding;
        const page = args.page as UserStateReadResponse;
        await options.runTransaction(async db => {
          await applyUserStateReadPageInDb(db, binding, page);
          requestUserStateDeferredApply(db);
        });
        return {
          handled: true,
          result: {
            value: { resumes: [] },
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<UserStateApplyEffects>,
        };
      }

      if (command === "db_user_state_acknowledge_operations") {
        const binding = args.binding as UserStateBinding;
        const results = args.results as UserStateMergeResult[];
        const runner =
          options.runExclusive ??
          ((run: (db: Database) => Promise<void>) =>
            options.runTransaction(run));
        await runner(async db => {
          await acknowledgeUserStateOperationsInDb(db, binding, results);
          requestUserStateDeferredApply(db);
        });
        return {
          handled: true,
          result: {
            value: { resumes: [] },
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<UserStateApplyEffects>,
        };
      }

      if (command === "db_user_state_resolve_conflict") {
        const binding = args.binding as UserStateBinding;
        const input = args.input as {
          id: string;
          version: string;
          choice: "local" | "shared";
          categoryName?: string;
        };
        await options.runTransaction(async db => {
          await resolveUserStateLedgerConflictInDb(db, binding, input);
          requestUserStateDeferredApply(db);
        });
        return {
          handled: true,
          result: {
            value: { resumes: [] },
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<UserStateApplyEffects>,
        };
      }

      if (command === "db_user_state_list_pending_projection_records") {
        const db = await options.getDb();
        return {
          handled: true,
          result: await listPendingUserStateProjectionRecordsInDb(
            db,
            args.binding as UserStateBinding,
          ),
        };
      }

      if (command === "db_user_state_project_records_chunk") {
        const binding = args.binding as UserStateBinding;
        const records = (args.records ?? []) as UserStateRecord[];
        const applied = await options.runTransaction(
          db => projectUserStateRecordsInDb(db, binding, records),
          true,
        );
        return {
          handled: true,
          result: {
            value: applied,
            effects: {},
          } satisfies DbMutationEnvelope<UserStateApplyEffects>,
        };
      }

      if (command === "db_user_state_record_resume") {
        const chapterId = args.chapterId as number;
        const rawAnchor = (args.anchor ?? null) as PortableReaderAnchor | null;
        const openedAt = args.openedAt as number;
        const portable =
          rawAnchor === null ? null : parsePortableReaderAnchor(rawAnchor);
        await options.runTransaction(async db => {
          if (!(await hasUserStateSchema(db))) return;
          const [row] = await db.select<UserChapterRow[]>(
            `${USER_CHAPTER_SELECT} WHERE c.id=$1`,
            [chapterId],
          );
          if (!row) return;
          await recordUserStateChangesInDb(db, [
            {
              entity: { kind: "resume", work: chapterWork(row) },
              value: {
                chapter: chapterReference(row),
                anchor: portable,
                openedAt,
              },
            },
          ]);
        });
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_user_state_record_resume_cleared") {
        const novelId = args.novelId as number;
        await options.runTransaction(db =>
          recordResumeClearedInDb(db, [novelId]),
        );
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_user_state_get_restore_paused") {
        const db = await options.getDb();
        return {
          handled: true,
          result: await userStateRestorePausedInDb(db),
        };
      }

      if (command === "db_user_state_assert_available") {
        const db = await options.getDb();
        await assertUserStateAvailableInDb(db);
        return { handled: true, result: null };
      }

      if (command === "db_user_state_resume_after_restore") {
        await options.runTransaction(async db => {
          await db.execute(
            "UPDATE user_state_restore_state SET paused=0 WHERE id=1",
          );
          await db.execute(
            "UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL,deferred_detail=NULL",
          );
        });
        return {
          handled: true,
          result: {
            value: null,
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_user_state_bind_current_workspace") {
        const binding = args.binding as UserStateBinding;
        await options.runTransaction(async db => {
          await assertUserStateAvailableInDb(db);
          if (!binding.serverUrl || !binding.workspaceId || !binding.epoch) {
            throw new Error(
              "A complete personal state workspace is required.",
            );
          }
          const [existing] = await db.select<{ namespace: string }[]>(
            "SELECT namespace FROM user_state_workspace WHERE server_url=$1",
            [binding.serverUrl],
          );
          if (existing) {
            await requireBinding(db, binding);
            return;
          }
          await db.execute(
            "INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch) VALUES($1,$2,$3,$4)",
            [
              binding.serverUrl,
              namespaceFor(binding),
              binding.workspaceId,
              binding.epoch,
            ],
          );
        });
        return {
          handled: true,
          result: {
            value: null,
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_user_state_get_current_status") {
        const db = await options.getDb();
        const serverUrl = (args.serverUrl ?? null) as string | null;
        const empty: UserStateCurrentStatus = {
          workspaceId: null,
          epoch: null,
          lastSuccessAt: null,
          pausedAfterRestore: false,
          missingMetadataCount: 0,
        };
        if (!(await hasUserStateSchema(db))) {
          return { handled: true, result: empty };
        }
        const [row] = await db.select<
          Array<{
            workspaceId: string | null;
            epoch: string | null;
            lastSuccessAt: number | null;
            paused: number;
            missingMetadataCount: number;
          }>
        >(
          `SELECT w.workspace_id AS workspaceId,w.epoch,w.last_success_at AS lastSuccessAt,r.paused,
            COALESCE(json_extract(c.payload,'$.missingMetadataCount'),0)+COALESCE(json_extract(e.payload,'$.missingMetadataCount'),0) AS missingMetadataCount
          FROM user_state_restore_state r LEFT JOIN user_state_workspace w ON w.server_url=$1
          LEFT JOIN content_sync_cache c ON c.cache_key='user-state-current-status:'||w.namespace
          LEFT JOIN content_sync_cache e ON e.cache_key='user-state-current-export:'||w.namespace WHERE r.id=1`,
          [serverUrl],
        );
        return {
          handled: true,
          result: row
            ? {
                workspaceId: row.workspaceId,
                epoch: row.epoch,
                lastSuccessAt: row.lastSuccessAt,
                pausedAfterRestore: !!row.paused,
                missingMetadataCount: row.missingMetadataCount,
              }
            : empty,
        };
      }

      if (command === "db_user_state_export_current_snapshot") {
        const binding = args.binding as UserStateBinding;
        const skipped = new Set<number>(
          (args.skippedChapterIds as number[] | undefined) ?? [],
        );
        const snapshot = await withChapterDownloadSnapshotReads(hold =>
          options.runTransaction(async db => {
            await assertUserStateAvailableInDb(db);
            await requireBinding(db, binding);
            const result = await buildCurrentSnapshotInDb(
              db,
              binding,
              await loadCurrentDataInDb(
                db,
                binding,
                chapterId => !skipped.has(chapterId) && hold(chapterId),
              ),
            );
            const parsed = parseUserStateCurrentSnapshot(result.snapshot);
            await db.execute(
              "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
              [
                currentExportKey(binding),
                JSON.stringify({
                  missingMetadataCount: result.missingMetadataCount,
                }),
              ],
            );
            return parsed;
          }),
        );
        return {
          handled: true,
          result: {
            value: snapshot,
            effects: {},
          } satisfies DbMutationEnvelope<UserStateCurrentSnapshot>,
        };
      }

      if (command === "db_user_state_prepare_deferred_current_retry") {
        const db = await options.getDb();
        const serverUrl = args.serverUrl as string;
        const novelIds = (args.novelIds ?? []) as number[];
        const [binding] = await db.select<UserStateBinding[]>(
          "SELECT server_url AS serverUrl,workspace_id AS workspaceId,epoch FROM user_state_workspace WHERE server_url=$1",
          [serverUrl],
        );
        if (!binding) return { handled: true, result: null };
        const [row] = await db.select<{ payload: string }[]>(
          "SELECT payload FROM content_sync_cache WHERE cache_key=$1",
          [currentCacheKey(binding)],
        );
        if (!row) return { handled: true, result: null };
        const cached = JSON.parse(row.payload) as {
          snapshot: unknown;
          missingKeys?: string[];
        };
        const works = await db.select<CurrentWork[]>(
          "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name,in_library AS inLibrary,library_added_at AS addedAt FROM novel WHERE id IN (SELECT value FROM json_each($1))",
          [JSON.stringify(novelIds)],
        );
        const workKeys = [
          ...new Set(
            works.filter(work => work.sourceNovelId).map(userStateWorkKey),
          ),
        ];
        return {
          handled: true,
          result: {
            binding,
            snapshot: cached.snapshot,
            missingKeys: cached.missingKeys ?? [],
            workKeys,
          },
        };
      }

      if (command === "db_user_state_apply_current_snapshot") {
        const binding = args.binding as UserStateBinding;
        const snapshot = parseUserStateCurrentSnapshot(args.snapshot);
        const retry = (args.retry ?? null) as {
          workKeys: string[];
          previousMissing: string[];
        } | null;
        const skipped = new Set<number>(
          (args.skippedChapterIds as number[] | undefined) ?? [],
        );
        const applied = await withChapterDownloadSnapshotReads(hold =>
          applyCurrentSnapshotWithTransactionsInDb(
            binding,
            snapshot,
            options.runTransaction,
            chapterId => !skipped.has(chapterId) && hold(chapterId),
            retry,
          ),
        );
        return {
          handled: true,
          result: {
            value: applied,
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<UserStateCurrentApplyResult>,
        };
      }

      return { handled: false };
    },
  };
}
