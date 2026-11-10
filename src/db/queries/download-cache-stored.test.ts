import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import { listDeletionDownloadedChapterIds } from "./content-deletion";
import {
  deleteDownloadCacheChapter,
  deleteDownloadCacheNovel,
  listDownloadCacheChapters,
  listDownloadCacheNovels,
  listNonLocalDownloadCacheDeleteChapters,
} from "./download-cache";

let sqlite: DatabaseSync;
const bind = (params: unknown[]) =>
  Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,is_local) VALUES
    (1,'source','/one','One',0), (2,'local','/local','Local',1), (3,'source','/three','Three',0);
    INSERT INTO chapter(id,novel_id,path,name,position,unread,is_downloaded,content_bytes,media_bytes,media_repair_needed) VALUES
    (1,1,'/1','Complete',1,1,1,100,50,0),
    (2,1,'/2','Text without images',2,0,0,30,5,1),
    (3,1,'/3','Not stored',3,1,0,0,0,0),
    (4,1,'/4','Repair flag only',4,1,0,0,0,1),
    (5,2,'/5','Local chapter',1,1,1,40,0,0),
    (6,3,'/6','Only partial',1,1,0,20,0,1)`);
  const db = {
    select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(bind(params)),
    execute: async (sql: string, params: unknown[] = []) =>
      ({ rowsAffected: Number(sqlite.prepare(sql).run(bind(params)).changes) }),
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
});
afterEach(() => sqlite.close());

it("counts a chapter whose text is stored without its media like the library does", async () => {
  const novels = await listDownloadCacheNovels();
  expect(novels.map((novel) => novel.novelId).sort()).toEqual([1, 3]);
  expect(novels.find((novel) => novel.novelId === 1)).toMatchObject({
    chaptersDownloaded: 2,
    totalChapters: 4,
    unreadDownloaded: 1,
    readDownloaded: 1,
    mediaRepairNeededChapters: 1,
    totalBytes: 185,
  });
  expect(novels.find((novel) => novel.novelId === 3)).toMatchObject({
    chaptersDownloaded: 1,
    mediaRepairNeededChapters: 1,
  });
});

it("lists the partial chapter among a work's stored chapters with its missing media", async () => {
  const chapters = await listDownloadCacheChapters(1);
  expect(chapters.map((chapter) => chapter.id)).toEqual([1, 2]);
  expect(chapters[1]).toMatchObject({ mediaRepairNeeded: true, totalBytes: 35, unread: false });
  expect(await listDownloadCacheChapters(2)).toEqual([]);
});

it("includes partial chapters in the deletion scope so the stored count drops to zero", async () => {
  expect(await listDeletionDownloadedChapterIds([1, 3])).toEqual([1, 2, 4, 6]);
  expect((await listNonLocalDownloadCacheDeleteChapters({ novelIds: [1] })).map((chapter) => chapter.id))
    .toEqual([1, 2, 4]);

  await expect(deleteDownloadCacheChapter(6)).resolves.toEqual({ rowsAffected: 1 });
  await expect(deleteDownloadCacheNovel(1)).resolves.toEqual({ rowsAffected: 2 });
  expect(await listDownloadCacheNovels()).toEqual([]);
  expect(sqlite.prepare("SELECT media_repair_needed AS flag FROM chapter WHERE id = 2").get()).toEqual({ flag: 0 });
});
