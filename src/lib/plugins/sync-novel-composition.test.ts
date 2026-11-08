import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "@tauri-apps/plugin-sql";
import type { ChapterCompositionV1, ChapterSourceSnapshot } from "../chapter-composition";
import type { Plugin, SourceNovel } from "./types";

vi.mock("../../db/client", () => ({ getDb: vi.fn(), getReadOnlyDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
vi.mock("../../db/queries/novel-identity", () => ({ reconcileImportedNovelIdentityInDb: vi.fn(async () => null) }));
vi.mock("./source-chapter-renumber", () => ({ withSourceChapterNumberReconciliation: vi.fn((_input: unknown, publish: (journal: null) => Promise<unknown>) => publish(null)) }));
vi.mock("../novel-cover-storage", () => ({ saveNovelCoverFromSource: vi.fn(async () => undefined) }));
vi.mock("../updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));
import { getDb, getReadOnlyDb, runDatabaseTransaction } from "../../db/client";
import { getChapterComposition, materializeChapterComposition, setChapterComposition } from "../../db/chapter-composition";
import { listChaptersByNovel } from "../../db/queries/chapter";
import { applyNovelMergeInDb } from "../../db/queries/novel-merge";
import { syncNovelFromSource } from "./sync-novel";

let sqlite: DatabaseSync;
let db: Database;
const source = (number: number, side = "b"): ChapterSourceSnapshot => ({
  pluginId: `source-${side}`, novelId: `work-${side}`, novelPath: `/${side}`, chapterPath: `/${side}/${number}`,
  sourceChapterId: `${side}${number}`, chapterNumber: String(number), name: `${side} ${number}`,
  position: number, page: "1", contentType: "html", releaseTime: null,
});
function initial(): ChapterCompositionV1 {
  return { version: 1, updatedAt: 10, entries: [
    { id: "b2", path: "/b/2", storageChapterNumber: "2", sources: [source(2)], primarySource: 0,
      user: { included: true, order: 1, name: "My opening", chapterNumber: "1" } },
    { id: "a1", path: "norea-composed:a1", storageChapterNumber: "1001", sources: [source(1, "a")], primarySource: 0,
      user: { included: true, order: 2, name: null, chapterNumber: "2" } },
    { id: "b1", path: "/b/1", storageChapterNumber: "1", sources: [source(1)], primarySource: 0,
      user: { included: true, order: 3, name: null, chapterNumber: "3" } },
    { id: "b3", path: "/b/3", storageChapterNumber: "3", sources: [source(3)], primarySource: 0,
      user: { included: false, order: 0, name: null, chapterNumber: null } },
  ] };
}
function plugin(detail: SourceNovel): Plugin {
  return { id: "source-b", name: "B", apiVersion: "0.2", version: "1", lang: "en", url: "https://b.test/plugin.js",
    iconUrl: "https://b.test/icon.png", getBaseUrl: () => "https://b.test", popularNovels: async () => [], searchNovels: async () => [],
    parseNovel: vi.fn(async () => detail), parseNovelSince: vi.fn(async () => detail),
    getChapterAcquisitionPlan: () => ({ type: "resource" }) };
}
beforeEach(async () => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/include_str!\("([^"]+)"\)/g)) sqlite.exec(readFileSync(`src-tauri/src/${match[1]}`, "utf8"));
  const bindings = (values: SQLInputValue[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
  db = { select: async (sql: string, values: SQLInputValue[] = []) => sqlite.prepare(sql).all(bindings(values)),
    execute: async (sql: string, values: SQLInputValue[] = []) => {
      const result = sqlite.prepare(sql).run(bindings(values));
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    } } as unknown as Database;
  vi.mocked(getDb).mockResolvedValue(db);
  vi.mocked(getReadOnlyDb).mockResolvedValue(db);
  vi.mocked(runDatabaseTransaction).mockImplementation(async run => {
    sqlite.exec("BEGIN");
    try { const result = await run(db); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(2,'source-b','work-b','/b','Target')");
  const composition = initial();
  await setChapterComposition(db, 2, composition);
  await materializeChapterComposition(db, 2, composition);
  sqlite.exec("UPDATE chapter SET is_downloaded=1,content_bytes=900,progress=72,bookmark=1,unread=0,read_at=50 WHERE path='/b/2'");
});
afterEach(() => sqlite.close());

describe("composed work database integration", () => {
  it("keeps the final list, files and read state after a full source renumber and title refresh", async () => {
    const before = sqlite.prepare("SELECT id,chapter_number,content_bytes,is_downloaded,progress,bookmark,unread,read_at FROM chapter WHERE path='/b/2'").get();
    const result = await syncNovelFromSource(plugin({ novelId: "work-b", path: "/b", name: "Fresh target", chapters: [
      { path: "/b/new-2", sourceChapterId: "b2", name: "Provider revised", chapterNumber: 102 },
      { path: "/b/3", sourceChapterId: "b3", name: "Still excluded", chapterNumber: 103 },
      { path: "/b/4", sourceChapterId: "b4", name: "New ending", chapterNumber: 104 },
    ] }), { path: "/b", name: "Target" }, { novelId: 2, chapterRefreshMode: "full" });
    expect(result.changed).toBe(true);
    expect(sqlite.prepare("SELECT id,chapter_number,content_bytes,is_downloaded,progress,bookmark,unread,read_at FROM chapter WHERE path='/b/2'").get()).toEqual(before);
    const chapters = await listChaptersByNovel(2);
    expect(chapters.map(row => [row.path, row.position, row.displayChapterNumber])).toEqual([
      ["/b/2", 1, "1"], ["norea-composed:a1", 2, "2"], ["/b/1", 3, "3"], ["/b/4", 4, "4"],
    ]);
    expect(chapters[0].name).toBe("My opening");
    expect(chapters[0].compositionSource).toMatchObject({ chapterPath: "/b/new-2", chapterNumber: "102", name: "Provider revised" });
    expect(chapters[1].compositionSource).toMatchObject({ pluginId: "source-a", novelPath: "/a", chapterPath: "/a/1" });
    expect(chapters[3].chapterNumber).toBe("1002");
    expect((await getChapterComposition(db, 2))!.entries.find(row => row.path === "/b/3")!.user.included).toBe(false);
  });

  it("uses the provider anchor instead of the user's order or storage number for incremental checks", async () => {
    const p = plugin({ novelId: "work-b", path: "/b", name: "Target", chapters: [
      { path: "/b/3", sourceChapterId: "b3", name: "Still excluded", chapterNumber: 3 },
      { path: "/b/4", sourceChapterId: "b4", name: "New", chapterNumber: 4 },
    ] });
    await syncNovelFromSource(p, { path: "/b", name: "Target" }, { novelId: 2, chapterRefreshMode: "since" });
    expect(p.parseNovelSince).toHaveBeenCalledWith("/b", 3);
    expect(p.parseNovel).not.toHaveBeenCalled();
    expect((await listChaptersByNovel(2)).map(row => row.path)).toEqual(["/b/2", "norea-composed:a1", "/b/1", "/b/4"]);
  });

  it("materializes A-only and A-primary rows before applying a merge and retains B reading state", async () => {
    sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library) VALUES(1,'source-a','work-a','/a','Original',1)");
    sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,bookmark,unread,read_at) VALUES(51,1,'/a/2','A replacement','2',1,20,0,1,40)");
    sqlite.exec("INSERT INTO chapter_download_goal_exclusion(chapter_id,created_at) SELECT id,77 FROM chapter WHERE path='/b/2'");
    const composition = initial();
    composition.entries[0].user = { included: false, order: 0, name: "My opening", chapterNumber: "1" };
    composition.entries.push({ id: "replace-b2", path: "norea-composed:replace-b2", storageChapterNumber: "1002",
      sources: [source(2, "a"), source(2)], primarySource: 0,
      user: { included: true, order: 1, name: null, chapterNumber: "1" } });
    const merged = await applyNovelMergeInDb({ sourceNovelId: 1, targetNovelId: 2,
      decisions: [{ sourceChapterId: 51, kind: "map", targetChapterPath: "norea-composed:replace-b2" }],
      preparedDownloads: [], composition, readingStateSourcePathByTargetPath: { "norea-composed:replace-b2": "/b/2" } });
    expect(sqlite.prepare("SELECT id FROM novel WHERE id=1").get()).toBeUndefined();
    const chapters = await listChaptersByNovel(2);
    expect(chapters[0]).toMatchObject({ path: "norea-composed:replace-b2", chapterNumber: "1002", displayChapterNumber: "1", progress: 72, bookmark: true, unread: false, readAt: 50, isDownloaded: false });
    expect(merged.chapterIdMap[51]).toBe(chapters[0].id);
    expect(sqlite.prepare("SELECT created_at FROM chapter_download_goal_exclusion WHERE chapter_id=?").get(chapters[0].id)).toEqual({ created_at: 77 });
    expect(await getChapterComposition(db, 2)).toEqual(composition);
  });
});
