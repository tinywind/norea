import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  getDb: vi.fn(),
  runDatabaseTransaction: vi.fn(),
}));

import { getDb, runDatabaseTransaction } from "../client";
import {
  addNovelsToCategory,
  countNovelsByCategory,
  deleteCategory,
  getLibraryCategoryCounts,
  getNovelCategoryIds,
  insertCategory,
  listCategories,
  removeNovelsFromCategory,
  setNovelCategories,
  updateCategory,
} from "./category";

const mockedGetDb = vi.mocked(getDb);
let mockSelect: ReturnType<typeof vi.fn>;
let mockExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect = vi.fn();
  mockExecute = vi.fn();
  mockedGetDb.mockResolvedValue({
    select: mockSelect,
    execute: mockExecute,
  } as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async run => run({ select: mockSelect, execute: mockExecute } as never));
});

describe("listCategories", () => {
  it("orders by sort then name", async () => {
    mockSelect.mockResolvedValueOnce([
      { id: 1, name: "Default", sort: 0, isSystem: 1, novelCount: 3 },
      { id: 2, name: "Reading", sort: 1, isSystem: 0, novelCount: 5 },
    ]);
    const cats = await listCategories();

    const [sql] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("FROM category");
    expect(sql).toContain("COUNT(DISTINCT n.id) AS novelCount");
    expect(sql).toContain("ORDER BY c.sort, c.name");
    expect(cats).toHaveLength(2);
    expect(cats[0]?.isSystem).toBe(true);
    expect(cats[1]?.novelCount).toBe(5);
  });
});

describe("getLibraryCategoryCounts", () => {
  it("returns all and uncategorized library counts", async () => {
    mockSelect
      .mockResolvedValueOnce([{ count: 9 }])
      .mockResolvedValueOnce([{ count: 2 }]);

    const counts = await getLibraryCategoryCounts();

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(mockSelect.mock.calls[0]?.[0]).toContain("in_library = 1");
    expect(mockSelect.mock.calls[1]?.[0]).toContain("NOT EXISTS");
    expect(counts).toEqual({ total: 9, uncategorized: 2 });
  });
});

describe("insertCategory", () => {
  it("inserts non-system row with $1 name and $2 sort", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await insertCategory({ name: " Reading ", sort: 5 });

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO category");
    expect(sql).toContain("COALESCE($2");
    expect(sql).toContain("is_system");
    expect(params).toEqual(["Reading", 5]);
  });

  it("appends after the current max sort when sort is not supplied", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await insertCategory({ name: "Plans" });

    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toEqual(["Plans", null]);
  });

  it("rejects blank names", async () => {
    await expect(insertCategory({ name: "   " })).rejects.toThrow(
      "Category name is required.",
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("updateCategory", () => {
  it("renames manual categories only", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await updateCategory(7, { name: " New Name " });

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("UPDATE category");
    expect(sql).toContain("is_system = 0");
    expect(params).toEqual([7, "New Name"]);
  });
});

describe("deleteCategory", () => {
  it("deletes manual categories only", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await deleteCategory(7);

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM category");
    expect(sql).toContain("is_system = 0");
    expect(params).toEqual([7]);
  });
});

describe("addNovelsToCategory", () => {
  it("inserts unique novel-category pairs", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await addNovelsToCategory([3, 3, 4], 8);

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT OR IGNORE INTO novel_category");
    expect(sql).toContain("($1, $2), ($3, $4)");
    expect(params).toEqual([3, 8, 4, 8]);
  });

  it("does nothing when no valid novel ids are provided", async () => {
    await addNovelsToCategory([0, -1], 8);

    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("work category assignments", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec(`
      INSERT INTO novel (id, plugin_id, path, name, in_library)
      VALUES (1, 'source', '/first', 'First', 1), (2, 'source', '/second', 'Second', 1);
      INSERT INTO category (id, name, sort, is_system)
      VALUES (11, 'Reading', 1, 0), (12, 'Later', 0, 0), (13, 'Favorites', 2, 0), (14, 'System', 3, 1);
      INSERT INTO novel_category (novel_id, category_id)
      VALUES (1, 11), (1, 12), (2, 11), (2, 13);
    `);
    const parameters = (values: SQLInputValue[]) =>
      Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
    const db = {
      select: async (sql: string, values: SQLInputValue[] = []) => sqlite.prepare(sql).all(parameters(values)),
      execute: async (sql: string, values: SQLInputValue[] = []) => ({ rowsAffected: Number(sqlite.prepare(sql).run(parameters(values)).changes) }),
    };
    mockedGetDb.mockResolvedValue(db as never);
    vi.mocked(runDatabaseTransaction).mockImplementation(async (run) => {
      sqlite.exec("BEGIN");
      try {
        const result = await run(db as never);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    });
  });

  afterEach(() => sqlite.close());

  it("loads this work's manual assignments in category order", async () => {
    sqlite.exec("INSERT INTO novel_category (novel_id, category_id) VALUES (1, 14)");
    expect(await getNovelCategoryIds(1)).toEqual([12, 11]);
    expect(await getNovelCategoryIds(2)).toEqual([11, 13]);
  });

  it("removes only the chosen category from the selected works", async () => {
    await removeNovelsFromCategory([1, 1, 0, -1, 1.5], 11);
    expect(await getNovelCategoryIds(1)).toEqual([12]);
    expect(await getNovelCategoryIds(2)).toEqual([11, 13]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM category").get()).toEqual({ count: 4 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM novel").get()).toEqual({ count: 2 });
  });

  it("preserves assignments when a removal has no valid work IDs", async () => {
    await removeNovelsFromCategory([0, -1, NaN, 1.2], 11);
    expect(await getNovelCategoryIds(1)).toEqual([12, 11]);
    expect(await getNovelCategoryIds(2)).toEqual([11, 13]);
  });

  it("rejects the synthetic uncategorized filter as a category to remove", async () => {
    await expect(removeNovelsFromCategory([1], -1)).rejects.toThrow("Select a manual category");
    expect(await getNovelCategoryIds(1)).toEqual([12, 11]);
  });

  it("replaces selected assignments without changing another work", async () => {
    await setNovelCategories(1, [13, 13, 11]);
    expect(await getNovelCategoryIds(1)).toEqual([11, 13]);
    expect(await getNovelCategoryIds(2)).toEqual([11, 13]);
    expect(vi.mocked(runDatabaseTransaction)).toHaveBeenLastCalledWith(
      expect.any(Function),
      false,
      { publishMetadata: false, notifyContentSync: false, busyBeginRetries: 3 },
    );
  });

  it("journals only actual membership deltas instead of every category", async () => {
    sqlite.exec(readFileSync("src-tauri/src/migrations/0011_user_state_journal.sql", "utf8"));
    sqlite.exec("INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch) VALUES('https://state.example','ns','workspace','epoch')");

    await setNovelCategories(1, [11, 13]);

    const rows = sqlite.prepare(
      "SELECT m.local_id AS localId, json_extract(i.value_json,'$.included') AS included " +
      "FROM user_state_intent i " +
      "JOIN user_state_category m ON m.category_id=json_extract(i.entity_json,'$.categoryId') " +
      "WHERE json_extract(i.entity_json,'$.kind')='membership' ORDER BY m.local_id",
    ).all();
    expect(rows).toEqual([
      { localId: 12, included: 0 },
      { localId: 13, included: 1 },
    ]);
    expect(await getNovelCategoryIds(1)).toEqual([11, 13]);
  });

  it("clears all manual assignments while preserving works, categories and system assignments", async () => {
    sqlite.exec("INSERT INTO novel_category (novel_id, category_id) VALUES (1, 14)");
    await setNovelCategories(1, []);
    expect(await getNovelCategoryIds(1)).toEqual([]);
    expect(await getNovelCategoryIds(2)).toEqual([11, 13]);
    expect(sqlite.prepare("SELECT category_id FROM novel_category WHERE novel_id = 1").all()).toEqual([{ category_id: 14 }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM category").get()).toEqual({ count: 4 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM novel").get()).toEqual({ count: 2 });
  });

  it("retains previous assignments when a selected category disappears", async () => {
    await expect(setNovelCategories(1, [13, 99])).rejects.toMatchObject({ code: "category-not-found" });
    expect(await getNovelCategoryIds(1)).toEqual([12, 11]);
  });

  it("rejects edits after the work leaves the library", async () => {
    sqlite.exec("UPDATE novel SET in_library = 0 WHERE id = 1");
    await expect(setNovelCategories(1, [13])).rejects.toMatchObject({ code: "work-not-found" });
    expect(await getNovelCategoryIds(1)).toEqual([12, 11]);
  });

  it("rolls back the old assignments when inserting the replacement fails", async () => {
    sqlite.exec(`CREATE TRIGGER refuse_category BEFORE INSERT ON novel_category
      WHEN NEW.novel_id = 1 AND NEW.category_id = 13
      BEGIN SELECT RAISE(ABORT, 'Category write failed'); END`);
    await expect(setNovelCategories(1, [13])).rejects.toThrow("Category write failed");
    expect(await getNovelCategoryIds(1)).toEqual([12, 11]);
  });
});

describe("countNovelsByCategory", () => {
  it("counts selected novels per category across chunks", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => index + 1);
    mockSelect
      .mockResolvedValueOnce([{ categoryId: 4, count: 3 }, { categoryId: 5, count: 1 }])
      .mockResolvedValueOnce([{ categoryId: 4, count: 1 }]);

    const counts = await countNovelsByCategory([...ids, 1, 0]);

    expect(mockSelect).toHaveBeenCalledTimes(2);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("JOIN category c ON c.id = nc.category_id");
    expect(sql).toContain("GROUP BY nc.category_id");
    expect(params).toHaveLength(500);
    expect(mockSelect.mock.calls[1]![1]).toEqual([501]);
    expect([...counts]).toEqual([[4, 4], [5, 1]]);
  });

  it("does not query without valid novel ids", async () => {
    await expect(countNovelsByCategory([0, -2])).resolves.toEqual(new Map());
    expect(mockSelect).not.toHaveBeenCalled();
  });
});