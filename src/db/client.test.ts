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
