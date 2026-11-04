import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ getDb: vi.fn(), getReadOnlyDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
vi.mock("../updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));
vi.mock("../novel-cover-storage", () => ({ saveNovelCoverFromSource: vi.fn() }));

import { getDb, getReadOnlyDb, runDatabaseTransaction } from "../../db/client";
import { saveNovelCoverFromSource } from "../novel-cover-storage";
import { syncNovelFromSource, type SyncNovelFromSourceOptions } from "./sync-novel";
import type { ChapterItem, Plugin, SourceNovel } from "./types";

const NOVEL_PATH = "/webtoon/list?titleId=650305";
const CHAPTERS = 600;
const PAGE_SIZE = 100;
const FULL_REFRESH: SyncNovelFromSourceOptions = {
  novelId: 27, chapterRefreshMode: "full", preserveMissingMetadata: true, refreshCover: true,
};

let sqlite: DatabaseSync;

const chapterPath = (number: number) => `/webtoon/detail?titleId=650305&no=${number}`;
const sourceChapter = (number: number): ChapterItem => ({
  chapterNumber: number, name: `Part 2, episode ${number}`, path: chapterPath(number),
  releaseTime: `2026-10-${String(number % 28 + 1).padStart(2, "0")}`, contentType: "html",
});

/** Newest page first, as a paged source lists its chapters. */
function sourcePage(page: number): ChapterItem[] {
  const newest = CHAPTERS - (page - 1) * PAGE_SIZE;
  return Array.from({ length: Math.min(PAGE_SIZE, newest) }, (_, index) => sourceChapter(newest - index));
}

function sourceNovel(chapters: ChapterItem[]): SourceNovel {
  return {
    novelId: "650305", name: "Tiger Brother", path: NOVEL_PATH, cover: "https://source.test/new-cover.jpg",
    author: "New author", summary: "New summary", status: "Completed", genres: "Fantasy, Action", chapters,
  };
}

function makePlugin(parseNovel: () => Promise<SourceNovel>): Plugin {
  return {
    apiVersion: "0.2", id: "naver-webtoon", name: "Naver Webtoon", lang: "ko", version: "1.0.6",
    url: "https://example.test/index.js", iconUrl: "https://example.test/icon.png",
    getBaseUrl: () => "https://source.test", popularNovels: async () => [], searchNovels: async () => [],
    parseNovel,
    parseNovelSince: async (_path, since) => sourceNovel(
      Array.from({ length: CHAPTERS - since + 1 }, (_, index) => sourceChapter(since + index))),
    getChapterAcquisitionPlan: () => ({ type: "resource" }),
  };
}

async function parsePagedNovel(): Promise<SourceNovel> {
  const chapters: ChapterItem[] = [];
  for (let page = 1; (page - 1) * PAGE_SIZE < CHAPTERS; page += 1) chapters.push(...sourcePage(page));
  return sourceNovel(chapters);
}

function storedChapters() {
  return sqlite.prepare(`SELECT path, name, chapter_number AS chapterNumber, position, release_time AS releaseTime
    FROM chapter WHERE novel_id = 27 ORDER BY CAST(chapter_number AS REAL)`).all();
}

const expectedChapters = Array.from({ length: CHAPTERS }, (_, index) => {
  const chapter = sourceChapter(index + 1);
  return { path: chapter.path, name: chapter.name, chapterNumber: String(index + 1), position: index + 1, releaseTime: chapter.releaseTime };
});

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/include_str!\("([^"]+)"\)/g)) {
    sqlite.exec(readFileSync(`src-tauri/src/${match[1]}`, "utf8"));
  }
  const parameters = (values: SQLInputValue[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
  const db = {
    select: async (sql: string, values: SQLInputValue[] = []) => sqlite.prepare(sql).all(parameters(values)),
    execute: async (sql: string, values: SQLInputValue[] = []) => ({ rowsAffected: Number(sqlite.prepare(sql).run(parameters(values)).changes) }),
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
  vi.mocked(getReadOnlyDb).mockResolvedValue(db as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async run => {
    sqlite.exec("BEGIN");
    try { const result = await run(db as never); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
  vi.mocked(saveNovelCoverFromSource).mockResolvedValue(undefined);
  sqlite.exec(`INSERT INTO novel(id, plugin_id, source_novel_id, path, name, cover, author, summary, status, genres, in_library)
    VALUES (27, 'naver-webtoon', '650305', '${NOVEL_PATH}', 'Old title', 'https://source.test/old-cover.jpg',
      'Old author', 'Old summary', 'Ongoing', 'Old genre', 1)`);
  const insert = sqlite.prepare(`INSERT INTO chapter(novel_id, path, name, chapter_number, position, page, release_time)
    VALUES (27, $path, $name, $number, $position, '1', NULL)`);
  for (let number = 1; number <= CHAPTERS; number += 1) {
    const recovered = number <= CHAPTERS / 2;
    insert.run({
      $path: recovered ? `norea-folder:${number}` : chapterPath(number),
      $name: recovered ? String(number) : `Stale ${number}`,
      $number: String(number),
      $position: CHAPTERS + 1 - number,
    });
  }
});

afterEach(() => { sqlite.close(); });

it("rewrites every stale chapter, the novel details and the cover from a paged source list", async () => {
  const result = await syncNovelFromSource(makePlugin(parsePagedNovel), { name: "Old title", path: NOVEL_PATH }, FULL_REFRESH);

  expect(result.chapterCount).toBe(CHAPTERS);
  expect(storedChapters()).toEqual(expectedChapters);
  expect(sqlite.prepare("SELECT name, cover, author, summary, status, genres FROM novel WHERE id = 27").get()).toEqual({
    name: "Tiger Brother", cover: "https://source.test/new-cover.jpg", author: "New author",
    summary: "New summary", status: "Completed", genres: "Fantasy, Action",
  });
  expect(saveNovelCoverFromSource).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "naver-webtoon" }), expect.objectContaining({ id: 27 }),
    "https://source.test/new-cover.jpg", { refresh: true },
  );
});

it("keeps a full refresh when a check for new chapters starts while it parses", async () => {
  let releaseFullParse!: () => void;
  const fullParseReleased = new Promise<void>(resolve => { releaseFullParse = resolve; });
  const plugin = makePlugin(async () => { await fullParseReleased; return parsePagedNovel(); });

  const full = syncNovelFromSource(plugin, { name: "Old title", path: NOVEL_PATH }, FULL_REFRESH);
  const check = await syncNovelFromSource(plugin, { name: "Old title", path: NOVEL_PATH },
    { novelId: 27, chapterRefreshMode: "since", markFoundByCheck: true, preserveMissingMetadata: true });
  releaseFullParse();

  expect(check.chapterCount).toBe(1);
  expect((await full).chapterCount).toBe(CHAPTERS);
  expect(storedChapters()).toEqual(expectedChapters);
  expect(saveNovelCoverFromSource).toHaveBeenCalledTimes(2);
  expect(saveNovelCoverFromSource).toHaveBeenLastCalledWith(
    expect.anything(), expect.objectContaining({ id: 27 }), "https://source.test/new-cover.jpg", { refresh: true },
  );
});

it("lets a later full refresh supersede an earlier one", async () => {
  let releaseFirstParse!: () => void;
  const firstParseReleased = new Promise<void>(resolve => { releaseFirstParse = resolve; });
  const outdated = sourceNovel([{ ...sourceChapter(1), name: "Outdated" }]);
  const first = syncNovelFromSource(makePlugin(async () => { await firstParseReleased; return outdated; }),
    { name: "Old title", path: NOVEL_PATH }, FULL_REFRESH);
  const second = await syncNovelFromSource(makePlugin(parsePagedNovel), { name: "Old title", path: NOVEL_PATH }, FULL_REFRESH);
  releaseFirstParse();

  expect(await first).toEqual(second);
  expect(storedChapters()).toEqual(expectedChapters);
});
