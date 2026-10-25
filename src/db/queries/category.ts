import { getDb, runDatabaseTransaction } from "../client";

export const UNCATEGORIZED_CATEGORY_ID = -1;

export interface LibraryCategory {
  id: number;
  name: string;
  sort: number;
  isSystem: boolean;
  novelCount: number;
}

export async function listCategories(): Promise<LibraryCategory[]> {
  const db = await getDb();
  const rows = await db.select<
    Array<Omit<LibraryCategory, "isSystem"> & { isSystem: number }>
  >(`
    SELECT
      c.id,
      c.name,
      c.sort,
      c.is_system AS isSystem,
      COUNT(DISTINCT n.id) AS novelCount
    FROM category c
    LEFT JOIN novel_category nc ON nc.category_id = c.id
    LEFT JOIN novel n ON n.id = nc.novel_id AND n.in_library = 1
    GROUP BY c.id, c.name, c.sort, c.is_system
    ORDER BY c.sort, c.name
  `);
  return rows.map((row) => ({
    ...row,
    isSystem: !!row.isSystem,
    novelCount: Number(row.novelCount),
  }));
}

export interface LibraryCategoryCounts {
  total: number;
  uncategorized: number;
}

export async function getLibraryCategoryCounts(): Promise<LibraryCategoryCounts> {
  const db = await getDb();
  const totalRows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) AS count FROM novel WHERE in_library = 1",
  );
  const uncategorizedRows = await db.select<{ count: number }[]>(`
    SELECT COUNT(*) AS count
    FROM novel n
    WHERE
      n.in_library = 1
      AND NOT EXISTS (
        SELECT 1
        FROM novel_category nc
        WHERE nc.novel_id = n.id
      )
  `);

  return {
    total: totalRows[0]?.count ?? 0,
    uncategorized: uncategorizedRows[0]?.count ?? 0,
  };
}

export interface InsertCategoryInput {
  name: string;
  sort?: number;
}

export async function insertCategory(input: InsertCategoryInput): Promise<void> {
  const db = await getDb();
  const name = normalizeCategoryName(input.name);
  await db.execute(
    `INSERT INTO category (name, sort, is_system)
     VALUES (
       $1,
       COALESCE($2, (SELECT COALESCE(MAX(sort), -1) + 1 FROM category)),
       0
     )`,
    [name, input.sort ?? null],
  );
}

export interface UpdateCategoryInput {
  name: string;
}

export async function updateCategory(
  id: number,
  input: UpdateCategoryInput,
): Promise<void> {
  assertManualCategoryId(id);
  const db = await getDb();
  const name = normalizeCategoryName(input.name);
  await db.execute(
    `UPDATE category
     SET name = $2
     WHERE id = $1 AND is_system = 0`,
    [id, name],
  );
}

export async function deleteCategory(id: number): Promise<void> {
  assertManualCategoryId(id);
  const db = await getDb();
  await db.execute("DELETE FROM category WHERE id = $1 AND is_system = 0", [
    id,
  ]);
}

export async function addNovelsToCategory(
  novelIds: readonly number[],
  categoryId: number,
): Promise<void> {
  assertManualCategoryId(categoryId);
  const uniqueNovelIds = Array.from(new Set(novelIds)).filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (uniqueNovelIds.length === 0) return;

  const db = await getDb();
  const params = uniqueNovelIds.flatMap((novelId) => [novelId, categoryId]);
  const values = uniqueNovelIds
    .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
    .join(", ");

  await db.execute(
    `INSERT OR IGNORE INTO novel_category (novel_id, category_id)
     VALUES ${values}`,
    params,
  );
}

export async function removeNovelsFromCategory(
  novelIds: readonly number[],
  categoryId: number,
): Promise<void> {
  assertManualCategoryId(categoryId);
  const uniqueNovelIds = Array.from(new Set(novelIds)).filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (uniqueNovelIds.length === 0) return;

  const db = await getDb();
  const params: unknown[] = [categoryId, ...uniqueNovelIds];
  const placeholders = uniqueNovelIds.map((_, index) => "$" + (index + 2)).join(", ");
  await db.execute(
    "DELETE FROM novel_category WHERE category_id = $1 AND novel_id IN (" + placeholders + ")",
    params,
  );
}

export class NovelCategoryError extends Error {
  constructor(readonly code: "work-not-found" | "category-not-found") {
    super(code === "work-not-found"
      ? "The work is no longer in the library."
      : "A selected category is no longer available.");
    this.name = "NovelCategoryError";
  }
}

export async function getNovelCategoryIds(novelId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ categoryId: number }[]>(
    `SELECT nc.category_id AS categoryId
     FROM novel_category nc
     JOIN category c ON c.id = nc.category_id AND c.is_system = 0
     WHERE nc.novel_id = $1
     ORDER BY c.sort, c.name`,
    [novelId],
  );
  return rows.map((row) => row.categoryId);
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

  await runDatabaseTransaction(async (db) => {
    const works = await db.select<{ id: number }[]>(
      "SELECT id FROM novel WHERE id = $1 AND in_library = 1",
      [novelId],
    );
    if (works.length === 0) throw new NovelCategoryError("work-not-found");

    if (uniqueCategoryIds.length > 0) {
      const placeholders = uniqueCategoryIds.map((_, index) => `$${index + 1}`).join(", ");
      const categories = await db.select<{ id: number }[]>(
        `SELECT id FROM category WHERE is_system = 0 AND id IN (${placeholders})`,
        uniqueCategoryIds,
      );
      if (categories.length !== uniqueCategoryIds.length) {
        throw new NovelCategoryError("category-not-found");
      }
    }

    await db.execute(
      `DELETE FROM novel_category
       WHERE novel_id = $1 AND category_id IN (SELECT id FROM category WHERE is_system = 0)`,
      [novelId],
    );
    if (uniqueCategoryIds.length === 0) return;

    const values = uniqueCategoryIds.map((_, index) => `($1, $${index + 2})`).join(", ");
    await db.execute(
      `INSERT INTO novel_category (novel_id, category_id) VALUES ${values}`,
      [novelId, ...uniqueCategoryIds],
    );
  });
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
