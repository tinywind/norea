import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import { markChapterMediaRepairPending, saveChapterContentMetadata, saveChapterPartialContentMetadata } from "./chapter";

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name) VALUES (1,'source','/book','Book');
    INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,media_repair_needed,media_bytes)
    VALUES (1,1,'/1','Chapter',1,0,1,123)`);
  vi.mocked(getDb).mockResolvedValue({
    execute: async (sql: string, params: unknown[] = []) => {
      const result = sqlite.prepare(sql).run(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes) };
    },
  } as never);
});
afterEach(() => sqlite.close());

it("retains the incomplete flag after a partial repair until final content is published", async () => {
  const html = '<img src="norea-media://reader-asset/good.png"><img src="norea-media://reader-asset/missing.png">';
  await saveChapterPartialContentMetadata(1, html, "html");
  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed,media_bytes FROM chapter").get()).toEqual({
    is_downloaded: 0, media_repair_needed: 1, media_bytes: 123,
  });
  await saveChapterContentMetadata(1, html, "html", { mediaBytes: 456 });
  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed,media_bytes FROM chapter").get()).toEqual({
    is_downloaded: 1, media_repair_needed: 0, media_bytes: 456,
  });
});

it("marks repair pending without losing existing byte counts", async () => {
  sqlite.exec("UPDATE chapter SET is_downloaded=1, media_repair_needed=0");
  expect(await markChapterMediaRepairPending(1)).toEqual({ rowsAffected: 1 });
  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed,media_bytes FROM chapter").get()).toEqual({
    is_downloaded: 0, media_repair_needed: 1, media_bytes: 123,
  });
  expect(await markChapterMediaRepairPending(99)).toEqual({ rowsAffected: 0 });
});
