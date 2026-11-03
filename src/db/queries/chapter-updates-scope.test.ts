import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import { countNewLibraryChaptersSince, listLibraryUpdatesPage } from "./chapter";

let sqlite: DatabaseSync;
const params = (values: unknown[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/include_str!\("([^"]+)"\)/g)) {
    sqlite.exec(readFileSync(`src-tauri/src/${match[1]}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'s','/a','Library',1),(2,'s','/b','Browsed',0);
    INSERT INTO chapter(id,novel_id,path,name,position,unread,found_at,found_by_check) VALUES
      (1,1,'/1','Imported',1,1,100,0),(2,1,'/2','Found',2,1,200,1),(3,1,'/3','Found and read',3,0,300,1),
      (4,1,'/4','Found later',4,1,400,1),(5,2,'/5','Outside library',1,1,500,1)`);
  vi.mocked(getDb).mockResolvedValue({
    select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql).all(params(values)),
  } as never);
});

afterEach(() => { sqlite.close(); });

it("lists unread library chapters found by checks, and every unread one in the backlog", async () => {
  expect((await listLibraryUpdatesPage(10)).updates.map((row) => row.chapterId)).toEqual([4, 2]);
  expect((await listLibraryUpdatesPage(10, null, "backlog")).updates.map((row) => row.chapterId)).toEqual([4, 2, 1]);
});

it("counts the new chapters found since Updates was last opened", async () => {
  expect(await countNewLibraryChaptersSince(0)).toBe(2);
  expect(await countNewLibraryChaptersSince(200)).toBe(1);
  expect(await countNewLibraryChaptersSince(400)).toBe(0);
});

it("sorts new chapters by a parseable source release time and pages through it", async () => {
  sqlite.exec(`UPDATE chapter SET release_time='1970-01-01T00:01:40Z' WHERE id=4;
    UPDATE chapter SET release_time='3 days ago' WHERE id=2;
    INSERT INTO chapter(id,novel_id,path,name,position,unread,found_at,found_by_check,release_time) VALUES
      (6,1,'/6','Released later than found',6,1,250,1,'2099-01-01')`);

  const first = await listLibraryUpdatesPage(2);
  expect(first.updates.map((row) => [row.chapterId, row.sortAt])).toEqual([[6, 250], [2, 200]]);
  const second = await listLibraryUpdatesPage(2, first.nextCursor);
  expect(second.updates.map((row) => [row.chapterId, row.sortAt])).toEqual([[4, 100]]);
  expect((await listLibraryUpdatesPage(10, null, "backlog")).updates.map((row) => row.sortAt)).toEqual([400, 250, 200, 100]);
});
