import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import {
  getContinueReadingTarget,
  listContinueReading,
  type ContinueReadingEntry,
} from "./continue-reading";

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

function seed(sql: string) {
  sqlite.exec(sql);
}

it("lists unfinished latest chapters and finished ones with a next chapter, newest first", async () => {
  seed(`INSERT INTO novel(id,plugin_id,path,name,in_library,is_local) VALUES
    (1,'s','/1','Reading',1,0), (2,'s','/2','Finished with next',1,1),
    (3,'s','/3','Caught up',1,0), (4,'s','/4','Not in library',0,0),
    (5,'s','/5','Never read',1,0);
    INSERT INTO chapter(id,novel_id,path,name,position,progress,read_at) VALUES
    (10,1,'/a','One',1,100,100), (11,1,'/b','Two',2,40,300),
    (20,2,'/a','One',1,100,500), (21,2,'/b','Two',2,0,NULL),
    (30,3,'/a','Last',1,100,900),
    (40,4,'/a','One',1,10,1000),
    (50,5,'/a','One',1,0,NULL)`);

  const entries = await listContinueReading();

  expect(entries.map((entry) => entry.novelId)).toEqual([2, 1]);
  expect(entries[0]).toMatchObject({
    chapterId: 20,
    nextChapterId: 21,
    nextChapterPosition: 2,
    novelIsLocal: true,
    novelName: "Finished with next",
  });
  expect(entries[1]).toMatchObject({
    chapterId: 11,
    nextChapterId: null,
    novelIsLocal: false,
    progress: 40,
  });
});

it("uses the most recently read chapter of each novel, not its furthest one", async () => {
  seed(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES (1,'s','/1','Reread',1);
    INSERT INTO chapter(id,novel_id,path,name,position,progress,read_at) VALUES
    (10,1,'/a','One',1,20,800), (11,1,'/b','Two',2,100,200)`);

  const [entry] = await listContinueReading();

  expect(entry).toMatchObject({ chapterId: 10, nextChapterId: 11, progress: 20 });
});

it("returns at most six novels in one query", async () => {
  const novels = Array.from({ length: 8 }, (_, index) => index + 1);
  seed(
    `INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES ${novels
      .map((id) => `(${id},'s','/${id}','N${id}',1)`)
      .join(",")};
    INSERT INTO chapter(id,novel_id,path,name,position,progress,read_at) VALUES ${novels
      .map((id) => `(${id * 10},${id},'/a','One',1,10,${id})`)
      .join(",")}`,
  );
  const db = await getDb();
  const select = vi.spyOn(db, "select");

  const entries = await listContinueReading(50);

  expect(entries.map((entry) => entry.novelId)).toEqual([8, 7, 6, 5, 4, 3]);
  expect(select).toHaveBeenCalledOnce();
});

it("resumes an unfinished chapter and opens the next chapter of a finished one", () => {
  const base: ContinueReadingEntry = {
    chapterId: 11, chapterName: "One", chapterNumber: "1", nextChapterId: 12, nextChapterName: "Two", nextChapterNumber: "2", nextChapterPosition: 3, novelCover: null, novelId: 1,
    novelIsLocal: false, novelName: "N", novelPath: "/1", pluginId: "s", position: 2,
    progress: 40, readAt: 1,
  };

  expect(getContinueReadingTarget(base)).toEqual({ chapterId: 11, chapterName: "One", chapterNumber: "1", next: false, position: 2 });
  expect(getContinueReadingTarget({ ...base, progress: 100 })).toEqual({
    chapterId: 12,
    chapterName: "Two",
    chapterNumber: "2",
    next: true,
    position: 3,
  });
  expect(getContinueReadingTarget({ ...base, nextChapterId: null, progress: 100 })).toEqual({
    chapterId: 11,
    chapterName: "One",
    chapterNumber: "1",
    next: false,
    position: 2,
  });
});

it("projects current and next titles alongside independent provider IDs", async () => {
  seed("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'bookkor-novel','/book','Novel',1)");
  seed("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,read_at) VALUES(11,1,'/one','1화','346378',1,100,100),(12,1,'/latest','346화','5677728',346,0,NULL)");
  const [entry] = await listContinueReading();
  expect(entry).toMatchObject({
    chapterId: 11, chapterName: "1화", chapterNumber: "346378",
    nextChapterId: 12, nextChapterName: "346화", nextChapterNumber: "5677728",
  });
  expect(getContinueReadingTarget(entry!)).toEqual({
    chapterId: 12, chapterName: "346화", chapterNumber: "5677728", next: true, position: 346,
  });
  expect(getContinueReadingTarget({ ...entry!, progress: 11 })).toEqual({
    chapterId: 11, chapterName: "1화", chapterNumber: "346378", next: false, position: 1,
  });
});
