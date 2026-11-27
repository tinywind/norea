import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addNovelsToCategory,
  countNovelsByCategory,
  deleteCategory,
  getLibraryCategoryCounts,
  getNovelCategoryIds,
  insertCategory,
  listCategories,
  NovelCategoryError,
  removeNovelsFromCategory,
  reorderCategories,
  setNovelCategories,
  updateCategory,
} from "./category";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listCategories", () => {
  it("forwards read mode to db_category_list", async () => {
    mockedInvoke.mockResolvedValueOnce([
      { id: 1, name: "Default", sort: 0, isSystem: true, novelCount: 3 },
      { id: 2, name: "Reading", sort: 1, isSystem: false, novelCount: 5 },
    ]);

    const cats = await listCategories("committed");

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_list", {
      mode: "committed",
    });
    expect(cats).toHaveLength(2);
    expect(cats[0]?.isSystem).toBe(true);
    expect(cats[1]?.novelCount).toBe(5);
  });
});

describe("getLibraryCategoryCounts", () => {
  it("returns all and uncategorized library counts", async () => {
    mockedInvoke.mockResolvedValueOnce({ total: 9, uncategorized: 2 });

    const counts = await getLibraryCategoryCounts();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_category_get_library_counts",
      { mode: "queued" },
    );
    expect(counts).toEqual({ total: 9, uncategorized: 2 });
  });
});

describe("insertCategory", () => {
  it("trims name and forwards sort", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: undefined, effects: {} });
    await insertCategory({ name: " Reading ", sort: 5 });

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_insert", {
      input: { name: "Reading", sort: 5 },
    });
  });

  it("sends null sort when sort is omitted", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: undefined, effects: {} });
    await insertCategory({ name: "Plans" });

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_insert", {
      input: { name: "Plans", sort: null },
    });
  });

  it("rejects blank names before invoking IPC", async () => {
    await expect(insertCategory({ name: "   " })).rejects.toThrow(
      "Category name is required.",
    );
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe("updateCategory", () => {
  it("renames manual categories with trimmed name", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: undefined, effects: {} });
    await updateCategory(7, { name: " New Name " });

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_update", {
      id: 7,
      input: { name: "New Name" },
    });
  });
});

describe("reorderCategories", () => {
  it("forwards ordered manual category ids to db_category_reorder", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: undefined, effects: {} });
    await reorderCategories([9, 4, 7]);

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_reorder", {
      orderedIds: [9, 4, 7],
    });
  });

  it("skips IPC when no ids are provided", async () => {
    await reorderCategories([]);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("rejects synthetic, non-integer, or duplicate category ids before invoking IPC", async () => {
    await expect(reorderCategories([4, -1])).rejects.toThrow(
      "Select a manual category",
    );
    await expect(reorderCategories([4, 1.5])).rejects.toThrow(
      "Select a manual category",
    );
    await expect(reorderCategories([4, 4])).rejects.toThrow(
      "Category reorder ids must be unique.",
    );
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe("deleteCategory", () => {
  it("deletes manual categories only", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: undefined, effects: {} });
    await deleteCategory(7);

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_delete", { id: 7 });
  });
});

describe("addNovelsToCategory", () => {
  it("sends unique positive novel ids", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: undefined, effects: {} });
    await addNovelsToCategory([3, 3, 4], 8);

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_add_novels", {
      novelIds: [3, 4],
      categoryId: 8,
    });
  });

  it("does nothing when no valid novel ids are provided", async () => {
    await addNovelsToCategory([0, -1], 8);

    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe("work category assignments", () => {
  it.each(["queued", "committed"] as const)("loads manual assignments using a %s read", async (mode) => {
    mockedInvoke.mockResolvedValueOnce([12, 11]);
    expect(await getNovelCategoryIds(1, mode)).toEqual([12, 11]);
    expect(mockedInvoke).toHaveBeenCalledWith("db_category_get_novel_ids", {
      novelId: 1,
      mode,
    });
  });

  it("removes only positive integer work IDs from the chosen category", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: undefined, effects: {} });
    await removeNovelsFromCategory([1, 1, 0, -1, 1.5, 2], 11);

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_remove_novels", {
      novelIds: [1, 2],
      categoryId: 11,
    });
  });

  it("preserves assignments without invoking IPC when removal has no valid work IDs", async () => {
    await removeNovelsFromCategory([0, -1, Number.NaN, 1.2], 11);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("rejects the synthetic uncategorized filter as a category to remove", async () => {
    await expect(removeNovelsFromCategory([1], -1)).rejects.toThrow(
      "Select a manual category",
    );
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("deduplicates selected category IDs for setNovelCategories", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: undefined, effects: {} });
    await setNovelCategories(1, [13, 13, 11]);

    expect(mockedInvoke).toHaveBeenCalledWith("db_category_set_for_novel", {
      novelId: 1,
      categoryIds: [13, 11],
    });
  });

  it("maps category-not-found errors to NovelCategoryError", async () => {
    mockedInvoke.mockRejectedValueOnce(
      new Error("novel-category:category-not-found"),
    );

    await expect(setNovelCategories(1, [13, 99])).rejects.toEqual(
      expect.objectContaining({
        name: "NovelCategoryError",
        code: "category-not-found",
      }),
    );
  });

  it("maps work-not-found errors to NovelCategoryError", async () => {
    mockedInvoke.mockRejectedValueOnce(
      new Error("novel-category:work-not-found"),
    );

    await expect(setNovelCategories(1, [13])).rejects.toBeInstanceOf(
      NovelCategoryError,
    );
  });

  it("rejects non-positive work IDs before invoking IPC", async () => {
    await expect(setNovelCategories(0, [13])).rejects.toMatchObject({
      code: "work-not-found",
    });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe("countNovelsByCategory", () => {
  it("maps unique positive novel IDs into a category count Map", async () => {
    mockedInvoke.mockResolvedValueOnce([
      { categoryId: 4, count: 4 },
      { categoryId: 5, count: 1 },
    ]);

    const counts = await countNovelsByCategory([1, 2, 1, 0, -2]);

    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_category_count_novels_by_category",
      { novelIds: [1, 2] },
    );
    expect([...counts]).toEqual([
      [4, 4],
      [5, 1],
    ]);
  });

  it("does not query without valid novel ids", async () => {
    await expect(countNovelsByCategory([0, -2])).resolves.toEqual(new Map());
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
