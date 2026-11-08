import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), getReadOnlyDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { upsertSourceChaptersInDb } from "./chapter";

let sqlite: DatabaseSync;
const statements: string[] = [];
const params = (values: unknown[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never;
const db = {
  select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql).all(params(values)),
  execute: async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    return { rowsAffected: Number(sqlite.prepare(sql).run(params(values)).changes) };
  },
} as never;

beforeEach(() => {
  statements.length = 0;
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'s','/a','A'),(2,'s','/b','B');
    INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,page) VALUES
      (1,1,'/a/1-old','One',1,'1','1'),(2,1,'/a/2','Two',2,'2','1'),(3,2,'/b/1-old','B one',1,'1','1')`);
});

afterEach(() => { sqlite.close(); });

it("moves a renamed chapter path within the checked novel only", async () => {
  await upsertSourceChaptersInDb(db, [
    { novelId: 1, path: "/a/1-new", name: "One", position: 1, chapterNumber: "1" },
    { novelId: 1, path: "/a/2", name: "Two", position: 2, chapterNumber: "2" },
  ]);

  expect(sqlite.prepare("SELECT id, path FROM chapter ORDER BY id").all()).toEqual([
    { id: 1, path: "/a/1-new" }, { id: 2, path: "/a/2" }, { id: 3, path: "/b/1-old" },
  ]);
});

it("looks up only the checked novel's chapters instead of scanning the chapter table", async () => {
  await upsertSourceChaptersInDb(db, [{ novelId: 1, path: "/a/1-new", name: "One", position: 1, chapterNumber: "1" }]);
  const migration = statements.find((sql) => sql.includes("UPDATE chapter AS target"))!;

  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${migration}`).all(params([1, "/a/1-new", "1", "1"]))
    .map((row) => String((row as { detail: string }).detail));

  expect(plan.some((detail) => /^SEARCH target USING .*INDEX .*\(novel_id=\?/.test(detail))).toBe(true);
  expect(plan).not.toContain("SCAN target");
});
