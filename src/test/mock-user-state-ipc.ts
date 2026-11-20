import type { TestSqliteDatabase as Database } from "./sql/types";
import type { DbMutationEnvelope } from "../db/ipc";
import { createChapterIpcHandler } from "./mock-chapter-ipc";
import {
  parsePortableReaderAnchor,
  type PortableReaderAnchor,
  type UserStateApplyEffects,
  type UserStateBinding,
  type UserStateMergeResult,
  type UserStateOperation,
  type UserStateReadResponse,
  type UserStateRebindMode,
  type UserStateRecord,
} from "../lib/user-state/types";
import {
  assertUserStateAvailableInDb,
  chapterReference,
  chapterWork,
  hasUserStateSchema,
  namespaceFor,
  recordCategoryInDb,
  recordChaptersInDb,
  recordClearedReadingProgressInDb,
  recordMembershipInDb,
  recordResumeClearedInDb,
  recordUserStateChangesInDb,
  requestUserStateDeferredApply,
  requireBinding,
  snapshotReadingProgressClearTargetsInDb,
  stableCategoryIdInDb,
  USER_CHAPTER_SELECT,
  userStateRestorePausedInDb,
  workspaceRows,
  type UserChapterRow,
} from "./sql/user-state-core";
import {
  acknowledgeUserStateOperationsInDb,
  applyLocalUserStateRetentionInDb,
  applyUserStateReadPageInDb,
  bindUserStateWorkspaceInDb,
  getUserStateLedgerStatusInDb,
  listUserStateConflictsInDb,
  listUserStateDeferredInDb,
  prepareUserStateOperationsInDb,
  pruneAcknowledgedUserStateOperationsInDb,
  rebindUserStateWorkspaceInDb,
  reconcileUserStateSnapshotInDb,
  resolveUserStateLedgerConflictInDb,
  type UserStateLedgerStatus,
} from "./sql/user-state-ledger";
import {
  projectPendingUserStateInDb,
  refreshUnattemptedUserStateIdentitiesInDb,
} from "./sql/user-state-materialize";

export interface UserStateIpcBridgeOptions {
  getDb: () => Database | Promise<Database>;
  runTransaction: <T>(
    run: (db: Database) => Promise<T>,
    remoteContentSync?: boolean,
  ) => Promise<T>;
  runExclusive?: <T>(run: (db: Database) => Promise<T>) => Promise<T>;
}

export function createUserStateIpcHandler(options: UserStateIpcBridgeOptions) {
  const chapterIpc = createChapterIpcHandler({
    getDb: options.getDb,
    runTransaction: options.runTransaction,
  });

  return {
    async handle(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<{ handled: true; result: unknown } | { handled: false }> {
      const chapterHandled = await chapterIpc.handle(command, args);
      if (chapterHandled.handled) return chapterHandled;

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
        const seedAllowed = args.seedAllowed as boolean | undefined;
        const seedCutoffMs = args.seedCutoffMs as number | null | undefined;
        await options.runTransaction(db =>
          bindUserStateWorkspaceInDb(db, binding, {
            ...(seedAllowed !== undefined ? { seedAllowed } : {}),
            ...(seedCutoffMs !== undefined ? { seedCutoffMs } : {}),
          }),
        );
        return {
          handled: true,
          result: {
            value: null,
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_user_state_rebind_workspace") {
        const binding = args.binding as UserStateBinding;
        const mode = args.mode as UserStateRebindMode;
        const headRevision = args.headRevision as number | undefined;
        const seedCutoffMs = args.seedCutoffMs as number | null | undefined;
        const seedAllowed = args.seedAllowed as boolean | undefined;
        await options.runTransaction(db =>
          rebindUserStateWorkspaceInDb(db, binding, mode, {
            ...(headRevision !== undefined ? { headRevision } : {}),
            ...(seedCutoffMs !== undefined ? { seedCutoffMs } : {}),
            ...(seedAllowed !== undefined ? { seedAllowed } : {}),
          }),
        );
        return {
          handled: true,
          result: {
            value: null,
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_user_state_reconcile_snapshot") {
        const binding = args.binding as UserStateBinding;
        const records = args.records as UserStateRecord[];
        const snapshotRevision = args.snapshotRevision as number;
        const seedAllowed = args.seedAllowed as boolean | undefined;
        const seedCutoffMs = args.seedCutoffMs as number | null | undefined;
        const applied = await options.runTransaction(
          db =>
            reconcileUserStateSnapshotInDb(db, binding, {
              records,
              snapshotRevision,
              ...(seedAllowed !== undefined ? { seedAllowed } : {}),
              ...(seedCutoffMs !== undefined ? { seedCutoffMs } : {}),
            }),
          true,
        );
        return {
          handled: true,
          result: {
            value: applied,
            effects: { userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<UserStateApplyEffects>,
        };
      }

      if (command === "db_user_state_apply_local_retention") {
        const pruneNonLibraryDays = args.pruneNonLibraryDays as number | null | undefined;
        const stripTimestampsDays = args.stripTimestampsDays as number | null | undefined;
        const nowMs = args.nowMs as number | undefined;
        const affected = await options.runTransaction(db =>
          applyLocalUserStateRetentionInDb(db, {
            ...(pruneNonLibraryDays !== undefined ? { pruneNonLibraryDays } : {}),
            ...(stripTimestampsDays !== undefined ? { stripTimestampsDays } : {}),
            ...(nowMs !== undefined ? { nowMs } : {}),
          }),
        );
        return {
          handled: true,
          result: {
            value: affected,
            effects: { userStateLedgerChanged: affected > 0 },
          } satisfies DbMutationEnvelope<number>,
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
            projectionFailed: 0,
            lastSuccessAt: null,
            pausedAfterRestore: await userStateRestorePausedInDb(db),
          };
          return { handled: true, result: status };
        }
        const [row] = await db.select<{ pending: number }[]>(
          "SELECT COUNT(*) AS pending FROM user_state_intent WHERE COALESCE(json_extract(entity_json,'$.kind'),'')<>'library' AND COALESCE(json_extract(entity_json,'$.work.pluginId'),'')<>'local'",
        );
        const status: UserStateLedgerStatus = {
          cursor: 0,
          through: null,
          pending: row?.pending ?? 0,
          conflicts: 0,
          deferred: 0,
          projectionPending: 0,
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

      if (command === "db_user_state_prune_operations") {
        const binding = args.binding as UserStateBinding;
        const olderThanSecs = (args.olderThanSecs as number | undefined) ?? undefined;
        const pruned = await options.runTransaction(db =>
          pruneAcknowledgedUserStateOperationsInDb(db, binding, olderThanSecs),
        );
        return {
          handled: true,
          result: {
            value: pruned,
            effects: { userStateLedgerChanged: pruned > 0 },
          } satisfies DbMutationEnvelope<number>,
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

      if (command === "db_user_state_project_pending") {
        const binding = args.binding as UserStateBinding;
        const applied = await options.runTransaction(
          db => projectPendingUserStateInDb(db, binding),
          true,
        );
        return {
          handled: true,
          result: {
            value: applied,
            effects: { userStateLedgerChanged: true },
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
            "UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL,deferred_detail=NULL WHERE COALESCE(json_extract(payload,'$.entity.kind'),'')<>'library'",
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

      if (command === "db_category_insert") {
        const input = args.input as { name: string; sort?: number | null };
        await options.runTransaction(async db => {
          await db.execute(
            `INSERT INTO category (name, sort, is_system)
             VALUES (
               $1,
               COALESCE($2, (SELECT COALESCE(MAX(sort), -1) + 1 FROM category)),
               0
             )`,
            [input.name, input.sort ?? null],
          );
          if (await hasUserStateSchema(db)) {
            const [created] = await db.select<{ id: number }[]>(
              "SELECT id FROM category WHERE name=$1",
              [input.name],
            );
            if (created) await recordCategoryInDb(db, created.id, { create: true });
          }
        });
        return {
          handled: true,
          result: {
            value: undefined,
            effects: { userStatePriority: "normal", userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<undefined>,
        };
      }

      if (command === "db_category_update") {
        const id = args.id as number;
        const input = args.input as { name: string };
        await options.runTransaction(async db => {
          await stableCategoryIdInDb(db, id);
          await db.execute(
            "UPDATE category SET name = $2 WHERE id = $1 AND is_system = 0",
            [id, input.name],
          );
          await recordCategoryInDb(db, id);
        });
        return {
          handled: true,
          result: {
            value: undefined,
            effects: { userStatePriority: "normal", userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<undefined>,
        };
      }

      if (command === "db_category_delete") {
        const id = args.id as number;
        await options.runTransaction(async db => {
          await recordCategoryInDb(db, id, { deleted: true });
          if (await hasUserStateSchema(db)) {
            const members = await db.select<{ id: number }[]>(
              "SELECT novel_id AS id FROM novel_category WHERE category_id=$1",
              [id],
            );
            await recordMembershipInDb(db, members.map(row => row.id), id, false);
          }
          await db.execute("DELETE FROM category WHERE id = $1 AND is_system = 0", [id]);
        });
        return {
          handled: true,
          result: {
            value: undefined,
            effects: { userStatePriority: "normal", userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<undefined>,
        };
      }

      if (command === "db_category_set_for_novel") {
        const novelId = args.novelId as number;
        const uniqueCategoryIds = args.categoryIds as number[];
        await options.runTransaction(async db => {
          const works = await db.select<{ id: number }[]>(
            "SELECT id FROM novel WHERE id = $1 AND in_library = 1",
            [novelId],
          );
          if (works.length === 0) throw new Error("novel-category:work-not-found");
          if (uniqueCategoryIds.length > 0) {
            const placeholders = uniqueCategoryIds.map((_, index) => `$${index + 1}`).join(", ");
            const categories = await db.select<{ id: number }[]>(
              `SELECT id FROM category WHERE is_system = 0 AND id IN (${placeholders})`,
              uniqueCategoryIds,
            );
            if (categories.length !== uniqueCategoryIds.length) {
              throw new Error("novel-category:category-not-found");
            }
          }
          const currentRows = await db.select<{ id: number }[]>(
            `SELECT nc.category_id AS id
             FROM novel_category nc
             JOIN category c ON c.id=nc.category_id
             WHERE nc.novel_id=$1 AND c.is_system=0`,
            [novelId],
          );
          const currentIds = new Set(currentRows.map(row => row.id));
          const targetIds = new Set(uniqueCategoryIds);
          const removed = [...currentIds].filter(id => !targetIds.has(id));
          const added = uniqueCategoryIds.filter(id => !currentIds.has(id));
          if (await hasUserStateSchema(db)) {
            for (const id of removed) await recordMembershipInDb(db, [novelId], id, false);
            for (const id of added) await recordMembershipInDb(db, [novelId], id, true);
          }
          if (removed.length) {
            const placeholders = removed.map((_, index) => `$${index + 2}`).join(", ");
            await db.execute(
              `DELETE FROM novel_category WHERE novel_id=$1 AND category_id IN (${placeholders})`,
              [novelId, ...removed],
            );
          }
          if (added.length) {
            const values = added.map((_, index) => `($1, $${index + 2})`).join(", ");
            await db.execute(
              `INSERT OR IGNORE INTO novel_category (novel_id, category_id) VALUES ${values}`,
              [novelId, ...added],
            );
          }
        });
        return {
          handled: true,
          result: {
            value: undefined,
            effects: { userStatePriority: "normal", userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<undefined>,
        };
      }

      if (command === "db_maintenance_clear_library_membership") {
        const rowsAffected = await options.runTransaction(async db => {
          await db.execute(
            "DELETE FROM novel_download_goal WHERE novel_id IN (SELECT id FROM novel WHERE in_library = 1)",
          );
          const result = await db.execute(
            `UPDATE novel
             SET in_library = 0, library_added_at = NULL, updated_at = unixepoch()
             WHERE in_library = 1 OR library_added_at IS NOT NULL`,
          );
          return result.rowsAffected;
        });
        return {
          handled: true,
          result: {
            value: { rowsAffected },
            effects: {},
          } satisfies DbMutationEnvelope<{ rowsAffected: number }>,
        };
      }

      if (command === "db_maintenance_clear_updates_tab") {
        const rowsAffected = await options.runTransaction(async db => {
          const result = await db.execute(
            `UPDATE chapter
             SET progress = 100, updated_at = unixepoch()
             WHERE progress < 100
               AND novel_id IN (SELECT id FROM novel WHERE in_library = 1)
               AND COALESCE(created_at, updated_at) >= (
                 SELECT COALESCE(library_added_at, updated_at, created_at)
                 FROM novel
                 WHERE novel.id = chapter.novel_id
               )`,
          );
          if (await hasUserStateSchema(db)) {
            const rows = await db.select<{ id: number }[]>(
              `SELECT c.id FROM chapter c JOIN novel n ON n.id=c.novel_id
               WHERE n.in_library=1 AND COALESCE(c.created_at,c.updated_at)>=COALESCE(n.library_added_at,n.updated_at,n.created_at)`,
            );
            await recordChaptersInDb(db, rows.map(row => row.id));
          }
          return result.rowsAffected;
        });
        return {
          handled: true,
          result: {
            value: { rowsAffected },
            effects: { userStatePriority: "normal", userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<{ rowsAffected: number }>,
        };
      }

      if (command === "db_maintenance_clear_reading_progress") {
        const rowsAffected = await options.runTransaction(async db => {
          const targets = await snapshotReadingProgressClearTargetsInDb(db);
          const result = await db.execute(
            `UPDATE chapter
             SET progress = 0, read_at = NULL, updated_at = unixepoch()
             WHERE progress <> 0 OR read_at IS NOT NULL`,
          );
          await db.execute(
            `UPDATE novel
             SET last_read_at = NULL, updated_at = unixepoch()
             WHERE last_read_at IS NOT NULL`,
          );
          await recordClearedReadingProgressInDb(db, targets);
          return result.rowsAffected;
        });
        return {
          handled: true,
          result: {
            value: { rowsAffected },
            effects: { userStatePriority: "normal", userStateLedgerChanged: true },
          } satisfies DbMutationEnvelope<{ rowsAffected: number }>,
        };
      }

      if (command === "db_novel_set_in_library") {
        const id = args.id as number;
        const inLibrary = Boolean(args.inLibrary);
        await options.runTransaction(async db => {
          const flag = inLibrary ? 1 : 0;
          await db.execute(
            `UPDATE novel
             SET
               in_library = $2,
               library_added_at = CASE WHEN $2 = 1 THEN unixepoch() ELSE NULL END,
               updated_at = unixepoch()
             WHERE id = $1`,
            [id, flag],
          );
          if (inLibrary) {
            await db.execute(
              `UPDATE chapter
               SET found_at = MAX(COALESCE(found_at, 0), unixepoch())
               WHERE novel_id = $1`,
              [id],
            );
          } else {
            await db.execute("DELETE FROM novel_download_goal WHERE novel_id = $1", [id]);
          }
        }, false);
        return {
          handled: true,
          result: {
            value: null,
            effects: {},
          } satisfies DbMutationEnvelope<null>,
        };
      }

      return { handled: false };
    },
  };
}
