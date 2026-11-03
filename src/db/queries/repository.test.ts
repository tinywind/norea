import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../client";
import {
  addRepository,
  listRepositories,
  removeRepository,
  reorderRepositories,
  setRepositoryEnabled,
} from "./repository";

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
});

describe("listRepositories", () => {
  it("returns every repository in priority order with enabled as a boolean", async () => {
    mockSelect.mockResolvedValueOnce([
      { id: 2, url: "https://b.test/index.json", name: null, addedAt: 200, priority: 1, enabled: 0 },
      { id: 1, url: "https://a.test/index.json", name: "Alpha", addedAt: 100, priority: 2, enabled: 1 },
    ]);

    const rows = await listRepositories();

    const [sql] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("FROM repository");
    expect(sql).toContain("ORDER BY priority, id");
    expect(rows.map(({ id, enabled }) => [id, enabled])).toEqual([[2, false], [1, true]]);
  });
});

describe("addRepository", () => {
  it("appends the repository after the others without replacing any", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });

    await expect(addRepository({ url: "https://example.test/p.json", name: "Demo" })).resolves.toBe(true);

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO repository (url, name, priority, enabled)");
    expect(sql).toContain("COALESCE(MAX(priority), 0) + 1");
    expect(sql).toContain("ON CONFLICT(url) DO NOTHING");
    expect(sql).not.toContain("repository_index_cache");
    expect(params).toEqual(["https://example.test/p.json", "Demo"]);
  });

  it("reports a URL already in the list", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });

    await expect(addRepository({ url: "https://example.test/p.json" })).resolves.toBe(false);
    expect(mockExecute.mock.calls[0]![1]).toEqual(["https://example.test/p.json", null]);
  });
});

describe("repository order and enabled state", () => {
  it("stores enabled as 0 or 1", async () => {
    mockExecute.mockResolvedValue(undefined);

    await setRepositoryEnabled(3, false);

    expect(mockExecute.mock.calls[0]).toEqual(["UPDATE repository SET enabled = $1 WHERE id = $2", [0, 3]]);
  });

  it("writes the new order as priorities 1..n in one statement", async () => {
    mockExecute.mockResolvedValue(undefined);

    await reorderRepositories([5, 2, 9]);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("CASE id WHEN $1 THEN 1 WHEN $2 THEN 2 WHEN $3 THEN 3 END");
    expect(sql).toContain("WHERE id IN ($1, $2, $3)");
    expect(params).toEqual([5, 2, 9]);
  });
});

describe("removeRepository", () => {
  it("deletes the cache row before deleting the repository", async () => {
    mockExecute.mockResolvedValue(undefined);

    await removeRepository(42);

    const [cacheSql, cacheParams] = mockExecute.mock.calls[0]!;
    expect(cacheSql).toContain("DELETE FROM repository_index_cache");
    expect(cacheSql).toContain("SELECT url FROM repository WHERE id = $1");
    expect(cacheParams).toEqual([42]);

    const [repoSql, repoParams] = mockExecute.mock.calls[1]!;
    expect(repoSql).toContain("DELETE FROM repository");
    expect(repoSql).toContain("WHERE id = $1");
    expect(repoParams).toEqual([42]);
  });
});
