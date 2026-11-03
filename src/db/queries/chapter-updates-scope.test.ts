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
