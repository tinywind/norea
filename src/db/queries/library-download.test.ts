import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb } from "../client";
import {
  listExistingChapterIds,
  listLibraryDownloadChapters,
  listUnqueuedChapterDownloadIds,
} from "./chapter";

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,is_local) VALUES
    (1,'source','/one','One',0), (2,'source','/two','Two',0),
    (3,'local','/local','Local',1);
    INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,content_bytes) VALUES
    (1,1,'/1','Downloaded',1,1,20), (2,1,'/2','Queued',2,0,0),
    (3,1,'/3','Leased',3,0,0), (4,1,'/4','Partial',4,0,10),
    (5,1,'/5','Missing',5,0,0), (6,2,'/6','Other work',1,0,0),
    (7,3,'/7','Local work',1,0,0);
    INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms,leased_at_ms)
    VALUES (2,'{}',1,1,NULL), (3,'{}',1,1,1)`);
  vi.mocked(getDb).mockResolvedValue({
    select: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).all(
        Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never,
      ),
  } as never);
});
afterEach(() => sqlite.close());

it("checks a restored queue in bounded queries and retains existing completed chapters", async () => {
  const chapterIds = Array.from({ length: 16_503 }, (_, index) => 1_000 + index);
  const missingChapterId = chapterIds[11]!;
  const insert = sqlite.prepare(
    "INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded) VALUES (?,2,?,'Queued',?,?)",
  );
  for (const [index, id] of chapterIds.entries()) {
    if (id === missingChapterId) continue;
    insert.run(id, `/chapter/${id}`, index + 2, index % 2);
  }
  const db = await getDb();
  const select = vi.spyOn(db, "select");
  const existing = await listExistingChapterIds([...chapterIds, chapterIds[0]!]);

  expect(new Set(existing)).toEqual(new Set(chapterIds.filter((id) => id !== missingChapterId)));
  expect(select).toHaveBeenCalledTimes(Math.ceil(chapterIds.length / MAX_ROUTE_QUERY_ROWS));
  expect(select.mock.calls.every(([, params]) => params!.length <= MAX_ROUTE_QUERY_ROWS)).toBe(true);
  await expect(listExistingChapterIds([])).resolves.toEqual([]);
  expect(select).toHaveBeenCalledTimes(Math.ceil(chapterIds.length / MAX_ROUTE_QUERY_ROWS));
});

it("excludes stored bodies, persisted downloads and leased downloads", async () => {
  expect(await listUnqueuedChapterDownloadIds(1)).toEqual([5]);
  expect(await listUnqueuedChapterDownloadIds(2)).toEqual([6]);
  expect(await listUnqueuedChapterDownloadIds(3)).toEqual([]);

  sqlite.exec("DELETE FROM chapter_download_queue WHERE chapter_id = 2");
  expect(await listUnqueuedChapterDownloadIds(1)).toEqual([2, 5]);

  sqlite.exec("UPDATE chapter SET is_downloaded = 0 WHERE id = 1");
  expect(await listUnqueuedChapterDownloadIds(1)).toEqual([2, 5]);
  sqlite.exec("UPDATE chapter SET content_bytes = 0 WHERE id = 1");
  expect(await listUnqueuedChapterDownloadIds(1)).toEqual([1, 2, 5]);
});

it("keeps queued and downloaded reading anchors in the batch catalog", async () => {
  const chapters = await listLibraryDownloadChapters(1);
  expect(chapters.map((chapter) => chapter.id)).toEqual([1, 2, 3, 4, 5]);
  expect(chapters.filter((chapter) => chapter.isDownloadQueued).map((chapter) => chapter.id)).toEqual([2, 3]);
  expect(chapters[0]?.isDownloaded).toBe(true);
  expect(chapters[3]?.isDownloaded).toBe(false);
  expect(chapters[3]?.contentBytes).toBe(10);
});

it("bounds availability reads and continues past a page of scheduler reservations", async () => {
  const insert = sqlite.prepare("INSERT INTO chapter(id,novel_id,path,name,position) VALUES (?,2,?,'Pending',?)");
  for (let index = 0; index <= MAX_ROUTE_QUERY_ROWS; index += 1) {
    insert.run(1_000 + index, `/chapter/${index}`, index + 2);
  }
  const firstPage = await listUnqueuedChapterDownloadIds(2);
  expect(firstPage).toHaveLength(MAX_ROUTE_QUERY_ROWS);
  const secondPage = await listUnqueuedChapterDownloadIds(2, firstPage.at(-1));
  expect(secondPage).toEqual([1_499, 1_500]);
  expect(new Set([...firstPage, ...secondPage]).size).toBe(MAX_ROUTE_QUERY_ROWS + 2);
});
