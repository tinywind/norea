import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlPluginMock = vi.hoisted(() => ({
  get: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: sqlPluginMock,
}));

vi.mock("../lib/observability", () => ({
  startPerformanceObservation: vi.fn(() => vi.fn()),
}));

interface RawDbMock {
  close: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  path: string;
  select: ReturnType<typeof vi.fn>;
}

function makeRawDb(): RawDbMock {
  return {
    close: vi.fn(),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
    path: "sqlite:norea.db",
    select: vi
      .fn()
      .mockResolvedValue([
        { name: "media_repair_needed" },
        { name: "media_bytes_checked_at" },
      ]),
  };
}

async function loadClient(rawDb: RawDbMock) {
  vi.resetModules();
  sqlPluginMock.get.mockReturnValue(rawDb);
  return import("./client");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDb", () => {
  it("reuses the preloaded sqlite pool", async () => {
    const rawDb = makeRawDb();
    const { getDb } = await loadClient(rawDb);

    await getDb();

    expect(sqlPluginMock.get).toHaveBeenCalledWith("sqlite:norea.db");
    expect(sqlPluginMock.load).not.toHaveBeenCalled();
  });
});

describe("runDatabaseTransaction", () => {
  it("commits successful work inside one queued transaction", async () => {
    const rawDb = makeRawDb();
    const { runDatabaseTransaction } = await loadClient(rawDb);

    await expect(
      runDatabaseTransaction(async (db) => {
        await db.execute("UPDATE chapter SET name = $1", ["Chapter"]);
        return 42;
      }),
    ).resolves.toBe(42);

    expect(rawDb.execute.mock.calls.map(([sql]) => sql)).toEqual([
      "PRAGMA busy_timeout = 5000",
      `CREATE TABLE IF NOT EXISTS chapter_download_queue (
       chapter_id integer PRIMARY KEY NOT NULL,
       job_json text NOT NULL,
       created_at_ms integer NOT NULL,
       updated_at_ms integer NOT NULL,
       leased_at_ms integer,
       attempt_count integer DEFAULT 0 NOT NULL
     )`,
      `CREATE INDEX IF NOT EXISTS chapter_download_queue_created_idx
     ON chapter_download_queue (created_at_ms, chapter_id)`,
      "BEGIN IMMEDIATE",
      "UPDATE chapter SET name = $1",
      "COMMIT",
    ]);
  });

  it("rolls back when transactional work fails", async () => {
    const rawDb = makeRawDb();
    const { runDatabaseTransaction } = await loadClient(rawDb);

    await expect(
      runDatabaseTransaction(async (db) => {
        await db.execute("UPDATE chapter SET name = $1", ["Chapter"]);
        throw new Error("chapter failed");
      }),
    ).rejects.toThrow("chapter failed");

    expect(rawDb.execute.mock.calls.map(([sql]) => sql)).toEqual([
      "PRAGMA busy_timeout = 5000",
      `CREATE TABLE IF NOT EXISTS chapter_download_queue (
       chapter_id integer PRIMARY KEY NOT NULL,
       job_json text NOT NULL,
       created_at_ms integer NOT NULL,
       updated_at_ms integer NOT NULL,
       leased_at_ms integer,
       attempt_count integer DEFAULT 0 NOT NULL
     )`,
      `CREATE INDEX IF NOT EXISTS chapter_download_queue_created_idx
     ON chapter_download_queue (created_at_ms, chapter_id)`,
      "BEGIN IMMEDIATE",
      "UPDATE chapter SET name = $1",
      "ROLLBACK",
    ]);
  });
});
