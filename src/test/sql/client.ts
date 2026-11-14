import { vi } from "vitest";
import type { TestSqliteDatabase as Database } from "./types";

export const getDb: () => Promise<Database> = vi.fn();
export const getReadOnlyDb: () => Promise<Pick<Database, "select">> = vi.fn();
export const runDatabaseTransaction: <T>(
  run: (db: Database) => Promise<T>,
  remoteContentSync?: boolean,
  options?: {
    publishMetadata?: boolean;
    notifyContentSync?: boolean;
    busyBeginRetries?: number;
  },
) => Promise<T> = vi.fn() as never;
export const runExclusiveDatabaseOperation: <T>(
  run: (db: Database) => Promise<T>,
  options?: { publishMetadata?: boolean },
) => Promise<T> = vi.fn() as never;
