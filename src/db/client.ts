import Database from "@tauri-apps/plugin-sql";
import type { QueryResult } from "@tauri-apps/plugin-sql";
import { startPerformanceObservation } from "../lib/observability";

const DB_URL = "sqlite:norea.db";
const DB_BUSY_TIMEOUT_MS = 5000;
const CHAPTER_CONTENT_COLUMN = "content";
const MEDIA_REPAIR_NEEDED_COLUMN = "media_repair_needed";
const MEDIA_BYTES_CHECKED_AT_COLUMN = "media_bytes_checked_at";

let dbPromise: Promise<Database> | null = null;
let rawDbPromise: Promise<Database> | null = null;
let dbOperationQueue: Promise<void> = Promise.resolve();

function observationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureMediaRepairNeededColumn(db: Database): Promise<void> {
  const columns = await db.select<Array<{ name: string }>>(
    "PRAGMA table_info(chapter)",
  );
  if (columns.some((column) => column.name === MEDIA_REPAIR_NEEDED_COLUMN)) {
    return;
  }

  await db.execute(
    `ALTER TABLE chapter
     ADD COLUMN media_repair_needed integer DEFAULT false NOT NULL`,
  );
}

async function ensureMediaBytesCheckedAtColumn(db: Database): Promise<void> {
  const columns = await db.select<Array<{ name: string }>>(
    "PRAGMA table_info(chapter)",
  );
  if (
    columns.some((column) => column.name === MEDIA_BYTES_CHECKED_AT_COLUMN)
  ) {
    return;
  }

  await db.execute(
    `ALTER TABLE chapter
     ADD COLUMN media_bytes_checked_at integer`,
  );
  await db.execute(
    `UPDATE chapter
     SET media_bytes_checked_at = unixepoch()
     WHERE media_bytes > 0`,
  );
}

async function ensureNoChapterContentColumn(db: Database): Promise<void> {
  const columns = await db.select<Array<{ name: string }>>(
    "PRAGMA table_info(chapter)",
  );
  if (!columns.some((column) => column.name === CHAPTER_CONTENT_COLUMN)) {
    return;
  }

  await db.execute("ALTER TABLE chapter DROP COLUMN content");
}

async function configureDb(db: Database): Promise<Database> {
  await db.execute(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
  await ensureMediaRepairNeededColumn(db);
  await ensureMediaBytesCheckedAtColumn(db);
  await ensureNoChapterContentColumn(db);
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
        try {
          const result = await rawDb.execute(query, bindValues);
          finish({ rowsAffected: result.rowsAffected });
          return result;
        } catch (error) {
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
    rawDbPromise = Database.load(DB_URL).then(configureDb);
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
    dbPromise = getRawDb().then(serializedDb);
  }
  return dbPromise;
}

export async function runExclusiveDatabaseOperation<T>(
  run: (db: Database) => Promise<T>,
): Promise<T> {
  const rawDb = await getRawDb();
  return queueDbOperation(() => run(rawDb));
}

export async function runDatabaseTransaction<T>(
  run: (db: Database) => Promise<T>,
): Promise<T> {
  const rawDb = await getRawDb();
  return queueDbOperation(async () => {
    await rawDb.execute("BEGIN IMMEDIATE");
    try {
      const result = await run(rawDb);
      await rawDb.execute("COMMIT");
      return result;
    } catch (error) {
      await rawDb.execute("ROLLBACK").catch((rollbackError: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("[db] transaction rollback failed", rollbackError);
      });
      throw error;
    }
  });
}
