import { discardUserStateNotifications, notifyUserStateCommitted } from "./user-state-core";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
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
const DB_BEGIN_RETRY_DELAY_MS = 100;

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
    const { recoverSourceChapterRenumbersInDb } = await import("../lib/source-chapter-renumber");
    await recoverSourceChapterRenumbersInDb(db);
    const { recoverNovelMergeStorageInDb } = await import("../lib/novel-merge-storage");
    await recoverNovelMergeStorageInDb(db);
    await restoreWorkMetadataDirectories(db, false);
  }
  return db;
}

async function openRawDb(): Promise<Database> {
  if (isTauriRuntime()) {
    // The native process can survive a WebView reload. Roll back any abandoned
    // frontend transaction before this frontend lifetime starts using SQLite.
    await invoke("database_transaction_reset");
  }
  return configureDb(Database.get(DB_URL));
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
        const metadataMutation = isTauriRuntime() &&
          /\b(novel|chapter|novel_chapter_composition)\b/i.test(query) &&
          /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query);
        try {
          const result = metadataMutation
            ? await runDatabaseTransactionOnQueue(
                rawDb,
                db => db.execute(query, bindValues),
              )
            : await withWorkMetadataRollback(async () => {
                const result = await rawDb.execute(query, bindValues);
                if (/\b(novel|chapter|novel_chapter_composition|content_sync_journal)\b/i.test(query)) {
                  await notifyContentSyncChanges(rawDb);
                }
                notifyUserStateCommitted(rawDb);
                return result;
              });
          finish({ rowsAffected: result.rowsAffected });
          return result;
        } catch (error) {
          if (!metadataMutation) discardUserStateNotifications(rawDb);
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
    rawDbPromise = openRawDb();
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
      runTransaction: (rawDb, run) =>
        runDatabaseTransactionOnQueue(rawDb, run, false, { publishMetadata: false, notifyContentSync: false }),
      onProgress: progress => {
        if (controller.signal.aborted) return;
        useStorageRecoveryStore.setState({ status: "scanning", progress, error: null });
        if (progress.recoveredWorks > recoveredWorks) {
          recoveredWorks = progress.recoveredWorks;
          notifyWorkMetadataChanges();
        }
      },
    });
    notifyUserStateCommitted(db);
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
      notifyUserStateCommitted(rawDb);
      return result;
    } catch (error) {
      discardUserStateNotifications(rawDb);
      if (isTauriRuntime()) {
        await restoreWorkMetadataDirectories(rawDb, false);
      }
      throw error;
    }
  });
}

export interface DatabaseTransactionOptions {
  publishMetadata?: boolean;
  notifyContentSync?: boolean;
  /** Extra attempts to acquire BEGIN IMMEDIATE after SQLite reports BUSY/LOCKED. */
  busyBeginRetries?: number;
}

function isDatabaseBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:code:\s*(?:5|6)|database is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED))/i.test(message);
}

async function beginImmediate(db: Database, retries: number): Promise<void> {
  const attempts = Math.max(0, Math.floor(retries)) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await db.execute("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!isDatabaseBusyError(error) || attempt + 1 >= attempts) throw error;
      await new Promise<void>(resolve =>
        setTimeout(resolve, DB_BEGIN_RETRY_DELAY_MS * (attempt + 1)),
      );
    }
  }
}

interface DatabaseTransactionHandle {
  db: Database;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

function nativeTransactionDatabase(transactionId: string): Database {
  return {
    path: DB_URL,
    execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
      return invoke<QueryResult>("database_transaction_execute", {
        transactionId,
        query,
        values: bindValues ?? [],
      });
    },
    select<T>(query: string, bindValues?: unknown[]): Promise<T> {
      return invoke<T>("database_transaction_select", {
        transactionId,
        query,
        values: bindValues ?? [],
      });
    },
    close(): Promise<boolean> {
      return Promise.reject(
        new Error("Cannot close a database through an active transaction."),
      );
    },
  } as Database;
}

async function openDatabaseTransaction(
  rawDb: Database,
  retries: number,
): Promise<DatabaseTransactionHandle> {
  if (!isTauriRuntime()) {
    await beginImmediate(rawDb, retries);
    return {
      db: rawDb,
      commit: async () => {
        await rawDb.execute("COMMIT");
      },
      rollback: async () => {
        await rawDb.execute("ROLLBACK");
      },
    };
  }

  const transactionId = crypto.randomUUID();
  const attempts = Math.max(0, Math.floor(retries)) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await invoke("database_transaction_begin", { transactionId });
      return {
        db: nativeTransactionDatabase(transactionId),
        commit: () =>
          invoke("database_transaction_commit", { transactionId }),
        rollback: () =>
          invoke("database_transaction_rollback", { transactionId }),
      };
    } catch (error) {
      if (!isDatabaseBusyError(error) || attempt + 1 >= attempts) throw error;
      await new Promise<void>(resolve =>
        setTimeout(resolve, DB_BEGIN_RETRY_DELAY_MS * (attempt + 1)),
      );
    }
  }
  throw new Error("Database transaction could not be started.");
}

async function runDatabaseTransactionOnQueue<T>(
  rawDb: Database,
  run: (db: Database) => Promise<T>,
  remoteContentSync = false,
  options: DatabaseTransactionOptions = {},
): Promise<T> {
  const transaction = await openDatabaseTransaction(
    rawDb,
    options.busyBeginRetries ?? 0,
  );
  const transactionDb = transaction.db;
  let committed = false;
  try {
    const result = await withWorkMetadataRollback(async () => {
      if (remoteContentSync) {
        await transactionDb.execute(
          "UPDATE content_sync_origin SET remote=1 WHERE id=1",
        );
      }
      const value = await run(transactionDb);
      if (options.publishMetadata !== false) {
        await flushWorkMetadata(transactionDb);
      }
      if (remoteContentSync) {
        await transactionDb.execute(
          "UPDATE content_sync_origin SET remote=0 WHERE id=1",
        );
      }
      await transaction.commit();
      committed = true;
      return value;
    });
    notifyUserStateCommitted(transactionDb);
    if (options.notifyContentSync !== false) {
      await notifyContentSyncChanges(rawDb);
    }
    return result;
  } catch (error) {
    if (!committed) {
      discardUserStateNotifications(transactionDb);
      await transaction.rollback().catch((rollbackError: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("[db] transaction rollback failed", rollbackError);
      });
      if (isTauriRuntime()) {
        await restoreWorkMetadataDirectories(rawDb, false);
      }
    }
    throw error;
  }
}

export async function runDatabaseTransaction<T>(
  run: (db: Database) => Promise<T>,
  remoteContentSync = false,
  options: DatabaseTransactionOptions = {},
): Promise<T> {
  const rawDb = await getRawDb();
  return queueDbOperation(() =>
    runDatabaseTransactionOnQueue(
      rawDb,
      run,
      remoteContentSync,
      options,
    ),
  );
}
