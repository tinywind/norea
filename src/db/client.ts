import Database from "@tauri-apps/plugin-sql";
import type { QueryResult } from "@tauri-apps/plugin-sql";
import { startPerformanceObservation } from "../lib/observability";
import { notifyContentSyncChanges } from "./content-sync-journal";
import { flushWorkMetadata, initializeWorkMetadata, restoreWorkMetadataDirectories } from "./work-metadata";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { useStorageRecoveryStore } from "../store/storage-recovery";
import { describeError } from "../lib/errors";
import { notifyWorkMetadataChanges, withWorkMetadataRollback } from "../lib/work-metadata";

export type DatabaseReadMode = "queued" | "committed";

const DB_URL = "sqlite:norea.db";
const READ_DB_URL = "sqlite:norea-readonly.db";
const DB_BUSY_TIMEOUT_MS = 5000;

let dbPromise: Promise<Database> | null = null;
let rawDbPromise: Promise<Database> | null = null;
let dbOperationQueue: Promise<void> = Promise.resolve();
let metadataRecovery: AbortController | null = null;

function observationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function configureDb(db: Database): Promise<Database> {
  await db.execute(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
  if (isTauriRuntime()) {
    await restoreWorkMetadataDirectories(db, false);
  }
  return db;
}

async function queueDbOperation<T>(run: () => Promise<T>): Promise<T> {
  let releaseQueue: () => void = () => undefined;
  const previousQueue = dbOperationQueue;
  const currentQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  dbOperationQueue = previousQueue
    .catch(() => undefined)
    .then(() => currentQueue);

  await previousQueue.catch(() => undefined);
  try {
    return await run();
  } finally {
    releaseQueue();
  }
}

function serializedDb(rawDb: Database): Database {
  return {
    path: rawDb.path,
    execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
      const finish = startPerformanceObservation("db.execute", {
        bindValueCount: bindValues?.length ?? 0,
      });
      return queueDbOperation(async () => {
        const metadataMutation = isTauriRuntime() && /\b(novel|chapter)\b/i.test(query) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query);
        try {
          if (metadataMutation) await rawDb.execute("BEGIN IMMEDIATE");
          const result = await withWorkMetadataRollback(async () => {
            const result = await rawDb.execute(query, bindValues);
            if (metadataMutation) {
              await flushWorkMetadata(rawDb);
              await rawDb.execute("COMMIT");
            }
            return result;
          });
          if (/\b(novel|chapter|content_sync_journal)\b/i.test(query)) await notifyContentSyncChanges(rawDb);
          finish({ rowsAffected: result.rowsAffected });
          return result;
        } catch (error) {
          if (metadataMutation) {
            await rawDb.execute("ROLLBACK").catch(() => undefined);
            await restoreWorkMetadataDirectories(rawDb, false);
          }
          finish({ error: observationError(error), failed: true });
          throw error;
        }
      });
    },
    select<T>(query: string, bindValues?: unknown[]): Promise<T> {
      const finish = startPerformanceObservation("db.select", {
        bindValueCount: bindValues?.length ?? 0,
      });
      return queueDbOperation(async () => {
        try {
          const result = await rawDb.select<T>(query, bindValues);
          finish({
            rowCount: Array.isArray(result) ? result.length : undefined,
          });
          return result;
        } catch (error) {
          finish({ error: observationError(error), failed: true });
          throw error;
        }
      });
    },
    close(db?: string): Promise<boolean> {
      return queueDbOperation(() => rawDb.close(db));
    },
  } as Database;
}

function getRawDb(): Promise<Database> {
  if (!rawDbPromise) {
    rawDbPromise = configureDb(Database.get(DB_URL));
  }
  return rawDbPromise;
}

/**
 * Singleton accessor for the SQLite database.
 *
 * The Rust-side `tauri-plugin-sql` registration in
 * `src-tauri/src/lib.rs` runs the bootstrap schema migration the first
 * time this URL is loaded.
 */
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = getRawDb().then(db => {
      startWorkMetadataRecovery();
      return serializedDb(db);
    });
  }
  return dbPromise;
}

/** Reads committed data without waiting for metadata publication on the writer. */
export async function getReadOnlyDb(): Promise<Pick<Database, "select">> {
  await getDb();
  return Database.get(READ_DB_URL);
}

export function cancelWorkMetadataRecovery(): void {
  metadataRecovery?.abort();
  metadataRecovery = null;
  useStorageRecoveryStore.setState({ status: "idle", progress: null, error: null });
}

export function startWorkMetadataRecovery(rebuild = false): void {
  if (!isTauriRuntime() || (metadataRecovery && !rebuild)) return;
  cancelWorkMetadataRecovery();
  const controller = new AbortController();
  metadataRecovery = controller;
  let recoveredWorks = 0;
  void getRawDb().then(async db => {
    await initializeWorkMetadata(db, {
      rebuild, signal: controller.signal, runExclusive: queueDbOperation,
      onProgress: progress => {
        if (controller.signal.aborted) return;
        useStorageRecoveryStore.setState({ status: "scanning", progress, error: null });
        if (progress.recoveredWorks > recoveredWorks) {
          recoveredWorks = progress.recoveredWorks;
          notifyWorkMetadataChanges();
        }
      },
    });
    if (controller.signal.aborted) return;
    if (!controller.signal.aborted && useStorageRecoveryStore.getState().status === "scanning") {
      useStorageRecoveryStore.setState({ status: "complete" });
    }
  }).catch((error: unknown) => {
    if (!controller.signal.aborted) useStorageRecoveryStore.setState({ status: "error", error: describeError(error) });
  }).finally(() => {
    if (metadataRecovery === controller) metadataRecovery = null;
  });
}

export async function runExclusiveDatabaseOperation<T>(
  run: (db: Database) => Promise<T>,
  options: { publishMetadata?: boolean } = {},
): Promise<T> {
  const rawDb = await getRawDb();
  return queueDbOperation(async () => {
    try {
      const result = await run(rawDb);
      if (options.publishMetadata !== false) {
        await flushWorkMetadata(rawDb);
        await notifyContentSyncChanges(rawDb);
      }
      return result;
    } catch (error) {
      if (isTauriRuntime()) {
        await restoreWorkMetadataDirectories(rawDb, false);
      }
      throw error;
    }
  });
}

export async function runDatabaseTransaction<T>(
  run: (db: Database) => Promise<T>,
  remoteContentSync = false,
): Promise<T> {
  const rawDb = await getRawDb();
  return queueDbOperation(async () => {
    await rawDb.execute("BEGIN IMMEDIATE");
    try {
      const result = await withWorkMetadataRollback(async () => {
        if (remoteContentSync) await rawDb.execute("UPDATE content_sync_origin SET remote=1 WHERE id=1");
        const result = await run(rawDb);
        await flushWorkMetadata(rawDb);
        if (remoteContentSync) await rawDb.execute("UPDATE content_sync_origin SET remote=0 WHERE id=1");
        await rawDb.execute("COMMIT");
        return result;
      });
      await notifyContentSyncChanges(rawDb);
      return result;
    } catch (error) {
      await rawDb.execute("ROLLBACK").catch((rollbackError: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("[db] transaction rollback failed", rollbackError);
      });
      if (isTauriRuntime()) {
        await restoreWorkMetadataDirectories(rawDb, false);
      }
      throw error;
    }
  });
}
