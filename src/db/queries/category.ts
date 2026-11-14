import type { DatabaseReadMode } from "../client";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export const UNCATEGORIZED_CATEGORY_ID = -1;

export interface LibraryCategory {
  id: number;
  name: string;
  sort: number;
  isSystem: boolean;
  novelCount: number;
}

export async function listCategories(
  readMode: DatabaseReadMode = "queued",
): Promise<LibraryCategory[]> {
  return invokeDbQuery<LibraryCategory[]>("db_category_list", {
    mode: readMode,
  });
}

export interface LibraryCategoryCounts {
  total: number;
  uncategorized: number;
}

export async function getLibraryCategoryCounts(
  readMode: DatabaseReadMode = "queued",
): Promise<LibraryCategoryCounts> {
  return invokeDbQuery<LibraryCategoryCounts>("db_category_get_library_counts", {
    mode: readMode,
  });
}

export interface InsertCategoryInput {
  name: string;
  sort?: number;
}

export async function insertCategory(input: InsertCategoryInput): Promise<void> {
  const name = normalizeCategoryName(input.name);
  await invokeDbMutation("db_category_insert", {
    input: {
      name,
      sort: input.sort ?? null,
    },
  });
}

export interface UpdateCategoryInput {
  name: string;
}

export async function updateCategory(
  id: number,
  input: UpdateCategoryInput,
): Promise<void> {
  assertManualCategoryId(id);
  const name = normalizeCategoryName(input.name);
  await invokeDbMutation("db_category_update", {
    id,
    input: { name },
  });
}

export async function deleteCategory(id: number): Promise<void> {
  assertManualCategoryId(id);
  await invokeDbMutation("db_category_delete", { id });
}

export async function addNovelsToCategory(
  novelIds: readonly number[],
  categoryId: number,
): Promise<void> {
  assertManualCategoryId(categoryId);
  const uniqueNovelIds = filterPositiveIntegerIds(novelIds);
  if (uniqueNovelIds.length === 0) return;

  await invokeDbMutation("db_category_add_novels", {
    novelIds: uniqueNovelIds,
    categoryId,
  });
}

export async function removeNovelsFromCategory(
  novelIds: readonly number[],
  categoryId: number,
): Promise<void> {
  assertManualCategoryId(categoryId);
  const uniqueNovelIds = filterPositiveIntegerIds(novelIds);
  if (uniqueNovelIds.length === 0) return;

  await invokeDbMutation("db_category_remove_novels", {
    novelIds: uniqueNovelIds,
    categoryId,
  });
}

/** How many of the given novels belong to each category. */
export async function countNovelsByCategory(
  novelIds: readonly number[],
): Promise<Map<number, number>> {
  const uniqueNovelIds = filterPositiveIntegerIds(novelIds);
  const counts = new Map<number, number>();
  if (uniqueNovelIds.length === 0) return counts;

  const rows = await invokeDbQuery<Array<{ categoryId: number; count: number }>>(
    "db_category_count_novels_by_category",
    { novelIds: uniqueNovelIds },
  );
  for (const row of rows) {
    counts.set(row.categoryId, Number(row.count));
  }
  return counts;
}

export class NovelCategoryError extends Error {
  constructor(readonly code: "work-not-found" | "category-not-found") {
    super(
      code === "work-not-found"
        ? "The work is no longer in the library."
        : "A selected category is no longer available.",
    );
    this.name = "NovelCategoryError";
  }
}

export async function getNovelCategoryIds(novelId: number): Promise<number[]> {
  return invokeDbQuery<number[]>("db_category_get_novel_ids", { novelId });
}

export async function setNovelCategories(
  novelId: number,
  categoryIds: readonly number[],
): Promise<void> {
  if (!Number.isInteger(novelId) || novelId <= 0) {
    throw new NovelCategoryError("work-not-found");
  }
  const uniqueCategoryIds = Array.from(new Set(categoryIds));
  uniqueCategoryIds.forEach(assertManualCategoryId);

  try {
    await invokeDbMutation("db_category_set_for_novel", {
      novelId,
      categoryIds: uniqueCategoryIds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("novel-category:work-not-found")) {
      throw new NovelCategoryError("work-not-found");
    }
    if (message.includes("novel-category:category-not-found")) {
      throw new NovelCategoryError("category-not-found");
    }
    throw error;
  }
}

function filterPositiveIntegerIds(ids: readonly number[]): number[] {
  return Array.from(new Set(ids)).filter(
    (id) => Number.isInteger(id) && id > 0,
  );
}

function normalizeCategoryName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("Category name is required.");
  }
  return trimmed;
}

function assertManualCategoryId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Select a manual category.");
  }
}
