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
    select: vi.fn().mockResolvedValue([]),
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

  it("initializes a current database without rewriting the chapter schema", async () => {
    const rawDb = makeRawDb();
    const { getDb } = await loadClient(rawDb);

    await getDb();

    expect(rawDb.execute).toHaveBeenCalledWith("PRAGMA busy_timeout = 5000");
    expect(rawDb.execute.mock.calls.some(([sql]) => /ALTER TABLE|SET stored_content_type/.test(sql))).toBe(false);
    expect(rawDb.select).not.toHaveBeenCalledWith("PRAGMA table_info(chapter)");
  });
});

describe("runDatabaseTransaction", () => {
  it("commits successful work inside one queued transaction", async () => {
    const rawDb = makeRawDb();
    const { getDb, runDatabaseTransaction } = await loadClient(rawDb);
    await getDb();
    rawDb.execute.mockClear();

    await expect(
      runDatabaseTransaction(async (db) => {
        await db.execute("UPDATE chapter SET name = $1", ["Chapter"]);
        return 42;
      }),
    ).resolves.toBe(42);

    expect(rawDb.execute.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN IMMEDIATE",
      "UPDATE chapter SET name = $1",
      "COMMIT",
    ]);
  });

  it("retries only BEGIN IMMEDIATE when a native writer temporarily holds SQLite", async () => {
    const rawDb = makeRawDb();
    const { getDb, runDatabaseTransaction } = await loadClient(rawDb);
    await getDb();
    rawDb.execute.mockClear();
    let beginAttempts = 0;
    rawDb.execute.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN IMMEDIATE" && beginAttempts++ < 2) {
        throw new Error("error returned from database: (code: 5) database is locked");
      }
      return { rowsAffected: 0 };
    });
    const work = vi.fn(async (db: { execute: (sql: string) => Promise<unknown> }) => {
      await db.execute("UPDATE user_state_operation SET status='acknowledged'");
      return "done";
    });

    await expect(runDatabaseTransaction(work as never, false, { busyBeginRetries: 3 })).resolves.toBe("done");

    expect(work).toHaveBeenCalledOnce();
    expect(rawDb.execute.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN IMMEDIATE",
      "BEGIN IMMEDIATE",
      "BEGIN IMMEDIATE",
      "UPDATE user_state_operation SET status='acknowledged'",
      "COMMIT",
    ]);
  });

  it("does not retry a non-locking BEGIN failure", async () => {
    const rawDb = makeRawDb();
    const { getDb, runDatabaseTransaction } = await loadClient(rawDb);
    await getDb();
    rawDb.execute.mockClear();
    rawDb.execute.mockRejectedValueOnce(new Error("database disk image is malformed"));
    const work = vi.fn();

    await expect(runDatabaseTransaction(work, false, { busyBeginRetries: 3 })).rejects.toThrow("database disk image is malformed");

    expect(work).not.toHaveBeenCalled();
    expect(rawDb.execute).toHaveBeenCalledTimes(1);
    expect(rawDb.execute).toHaveBeenCalledWith("BEGIN IMMEDIATE");
  });

  it("can commit a remote projection without publishing metadata or content-sync notifications", async () => {
    const rawDb = makeRawDb();
    const { getDb, runDatabaseTransaction } = await loadClient(rawDb);
    await getDb();
    rawDb.execute.mockClear();

    await expect(runDatabaseTransaction(async db => {
      await db.execute("UPDATE chapter SET progress = $1", [73]);
      return "done";
    }, true, { publishMetadata: false, notifyContentSync: false })).resolves.toBe("done");

    expect(rawDb.execute.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN IMMEDIATE",
      "UPDATE content_sync_origin SET remote=1 WHERE id=1",
      "UPDATE chapter SET progress = $1",
      "UPDATE content_sync_origin SET remote=0 WHERE id=1",
      "COMMIT",
    ]);
  });

  it("rolls back when transactional work fails", async () => {
    const rawDb = makeRawDb();
    const { getDb, runDatabaseTransaction } = await loadClient(rawDb);
    await getDb();
    rawDb.execute.mockClear();

    await expect(
      runDatabaseTransaction(async (db) => {
        await db.execute("UPDATE chapter SET name = $1", ["Chapter"]);
        throw new Error("chapter failed");
      }),
    ).rejects.toThrow("chapter failed");

    expect(rawDb.execute.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN IMMEDIATE",
      "UPDATE chapter SET name = $1",
      "ROLLBACK",
    ]);
  });
});
