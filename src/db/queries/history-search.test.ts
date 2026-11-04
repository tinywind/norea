import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import { listReadingHistoryPage } from "./history-search";

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  vi.mocked(getDb).mockResolvedValue({
    select: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).all(
        Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never,
      ),
  } as never);
});
afterEach(() => sqlite.close());

/** Novel `id` was last read at `readAt`, on chapter `id * 10 + 2`. */
function seedNovels(count: number, name = (id: number) => `Novel ${id}`) {
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES ${ids
    .map((id) => `(${id},'s','/${id}','${name(id)}',${id % 2})`)
    .join(",")};
    INSERT INTO chapter(id,novel_id,path,name,position,progress,read_at) VALUES ${ids
      .flatMap((id) => [
        `(${id * 10 + 1},${id},'/a','Opening',1,100,${id})`,
        `(${id * 10 + 2},${id},'/b','Chapter ${id}',2,${id % 3 === 0 ? 100 : 30},${id + 1000})`,
      ])
      .join(",")}`);
}

it("pages through the latest read chapter of every novel, newest first", async () => {
  seedNovels(130);

  const first = await listReadingHistoryPage({ limit: 50 });
  expect(first.entries).toHaveLength(50);
  expect(first.entries[0]).toMatchObject({ chapterId: 1302, novelId: 130, novelInLibrary: false });
  const second = await listReadingHistoryPage({ cursor: first.nextCursor, limit: 50 });
  const third = await listReadingHistoryPage({ cursor: second.nextCursor, limit: 50 });

  const novelIds = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.novelId);
  expect(novelIds).toEqual(Array.from({ length: 130 }, (_, index) => 130 - index));
  expect(third.entries).toHaveLength(30);
  expect(third.nextCursor).toBeNull();
});

it("searches beyond the latest 100 entries by novel name, chapter name or number", async () => {
  seedNovels(150, (id) => (id === 3 ? "Dragon Tales" : `Novel ${id}`));

  const byName = await listReadingHistoryPage({ search: " dragon " });
  expect(byName.entries.map((entry) => entry.novelId)).toEqual([3]);
  expect(byName.nextCursor).toBeNull();

  const byChapter = await listReadingHistoryPage({ search: "Chapter 7" });
  expect(byChapter.entries.map((entry) => entry.novelId)).toEqual([79, 78, 77, 76, 75, 74, 73, 72, 71, 70, 7]);
  expect((await listReadingHistoryPage({ search: "Opening" })).entries).toEqual([]);
});

it("returns the chapter's own number and finds it by that number", async () => {
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES (1,'s','/1','Prologue first',1);
    INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,read_at) VALUES
    (10,1,'/a','Prologue','0',1,20,500)`);

  const [entry] = (await listReadingHistoryPage()).entries;
  expect(entry).toMatchObject({ chapterId: 10, chapterNumber: "0", position: 1 });
  expect((await listReadingHistoryPage({ search: "0" })).entries.map((row) => row.chapterId)).toEqual([10]);
});

it("applies the progress filter in the query, so pages stay full", async () => {
  seedNovels(30);

  const finished = await listReadingHistoryPage({ limit: 5, progress: "finished" });
  expect(finished.entries.map((entry) => entry.novelId)).toEqual([30, 27, 24, 21, 18]);
  expect(finished.nextCursor).not.toBeNull();
  const inProgress = await listReadingHistoryPage({ progress: "inProgress", search: "Chapter 2" });
  expect(inProgress.entries.map((entry) => entry.novelId)).toEqual([29, 28, 26, 25, 23, 22, 20, 2]);
});

it("keeps entries with the same read time in a stable order across pages", async () => {
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name) VALUES (1,'s','/1','A'),(2,'s','/2','B'),(3,'s','/3','C');
    INSERT INTO chapter(id,novel_id,path,name,position,progress,read_at) VALUES
    (11,1,'/a','One',4,10,500),(21,2,'/a','One',4,10,500),(31,3,'/a','One',9,10,500)`);

  const first = await listReadingHistoryPage({ limit: 2 });
  const second = await listReadingHistoryPage({ cursor: first.nextCursor, limit: 2 });

  expect([...first.entries, ...second.entries].map((entry) => entry.chapterId)).toEqual([31, 21, 11]);
  expect(second.nextCursor).toBeNull();
});
