import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readerStorage = vi.hoisted(() => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  return { original, originalWindow, values };
});

vi.mock("./client", () => ({ getDb: vi.fn(), getReadOnlyDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, getReadOnlyDb, runDatabaseTransaction } from "./client";
import {
  applyUserStateCurrentSnapshot, bindUserStateCurrentWorkspace, exportUserStateCurrentSnapshot,
  getUserStateCurrentStatus, setUserStateCurrentServer,
} from "./user-state-current";
import { currentCacheKey, currentCategoryId, currentStatusKey } from "./user-state-current-data";
import { deferUserStateForNovelInDb, resumeUserStateAfterRestore } from "./user-state";
import { remapPendingUserStateInDb } from "./user-state-migration";
import { discardUserStateNotifications, notifyUserStateCommitted, subscribeUserStateApplied, waitForUserStateDeferredApply } from "./user-state-core";
import { userStateEntityKey, type UserStateBinding, type UserStateValueMap, type UserStateWorkReference } from "../lib/user-state/types";
import { type UserStateCurrentItem, type UserStateCurrentSnapshot } from "../lib/user-state/current-types";
import type { ChapterCompositionV1 } from "../lib/chapter-composition";
import { useReaderStore } from "../store/reader";

interface Fixture { sql: DatabaseSync; db: Database; calls: number; delayMs: number }
const fixtures: Fixture[] = [];
let active: Fixture;
const binding: UserStateBinding = { serverUrl: "https://current.example", workspaceId: "workspace", epoch: "epoch" };
const work: UserStateWorkReference = { pluginId: "source", sourceNovelId: "book", novelPath: "/book", name: "Book" };
const readingValue = (progress: number, readAt: number | null = null): UserStateValueMap["reading"] => ({ progress, unread: progress < 100, readAt });
const reading = (path: string, progress: number, reference = work, readAt: number | null = null): UserStateCurrentItem => ({
  entity: { kind: "reading", work: reference, chapter: { chapterPath: path } }, value: readingValue(progress, readAt),
});
const snapshot = (items: UserStateCurrentItem[]): UserStateCurrentSnapshot => ({ version: 2, workspaceId: binding.workspaceId, epoch: binding.epoch, items });
function fixture(): Fixture {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  for (const match of readFileSync("src-tauri/src/database.rs", "utf8").matchAll(/version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g))
    sql.exec(readFileSync("src-tauri/src/" + match[2], "utf8"));
  const result = { sql, db: undefined as unknown as Database, calls: 0, delayMs: 0 };
  const params = (values: unknown[]) => Object.fromEntries(values.map((value, index) => ["$" + (index + 1), value]));
  const before = async () => { result.calls++; if (result.delayMs) await new Promise(resolve => setTimeout(resolve, result.delayMs)); };
  result.db = {
    select: async (query: string, values: unknown[] = []) => { await before(); return sql.prepare(query).all(params(values) as never); },
    execute: async (query: string, values: unknown[] = []) => {
      await before();
      const row = sql.prepare(query).run(params(values) as never);
      return { rowsAffected: Number(row.changes), lastInsertId: Number(row.lastInsertRowid) };
    },
  } as Database;
  fixtures.push(result); return result;
}
function addWork(target = active, novelId = 1, chapterId = 11, reference = work): void {
  target.sql.prepare("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(?,?,?,?,?)").run(novelId, reference.pluginId, reference.sourceNovelId, reference.novelPath, reference.name);
  target.sql.prepare("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(?,?,'/chapter/1','One','1',1)").run(chapterId, novelId);
}
async function tx<T>(target: Fixture, run: (db: Database) => Promise<T>): Promise<T> {
  target.sql.exec("BEGIN IMMEDIATE");
  try { const result = await run(target.db); target.sql.exec("COMMIT"); notifyUserStateCommitted(target.db); return result; }
  catch (error) { target.sql.exec("ROLLBACK"); discardUserStateNotifications(target.db); throw error; }
}
beforeEach(() => {
  readerStorage.values.clear();
  useReaderStore.getState().resetReadingProgress();
  active = fixture(); addWork();
  vi.mocked(getDb).mockImplementation(async () => active.db);
  vi.mocked(getReadOnlyDb).mockImplementation(async () => active.db);
  vi.mocked(runDatabaseTransaction).mockImplementation(run => tx(active, run));
  setUserStateCurrentServer(binding.serverUrl);
});
afterEach(async () => {
  setUserStateCurrentServer(null);
  await waitForUserStateDeferredApply();
  while (fixtures.length) fixtures.pop()!.sql.close();
});

afterAll(() => {
  if (readerStorage.original) Object.defineProperty(globalThis, "localStorage", readerStorage.original);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
  if (readerStorage.originalWindow) Object.defineProperty(globalThis, "window", readerStorage.originalWindow);
  else delete (globalThis as { window?: Window }).window;
});

function savedReaderPosition(chapterId = 11) {
  const position = {
    lastReadChapterByNovel: { 1: chapterId },
    novelPageIndexByNovel: { 1: 7 },
    chapterScrollAnchors: { [chapterId]: { novelId: 1, segmentIndex: 2, segmentCount: 10, offset: 0.25, progress: 35, savedAt: 10_000 } },
  };
  useReaderStore.setState(position);
  return position;
}
function currentReaderPosition() {
  const { lastReadChapterByNovel, novelPageIndexByNovel, chapterScrollAnchors } = useReaderStore.getState();
  return { lastReadChapterByNovel, novelPageIndexByNovel, chapterScrollAnchors };
}

describe("bulk current personal state", () => {
  it("exports the present database once without replaying older commands or sending omitted removals", async () => {
    active.sql.exec("UPDATE novel SET in_library=1; UPDATE chapter SET progress=100,unread=0,bookmark=1,read_at=20; INSERT INTO category(id,name,sort) VALUES(7,'Completed',0); INSERT INTO novel_category(novel_id,category_id) VALUES(1,7)");
    const old = reading("/chapter/1", 10);
    active.sql.prepare("INSERT INTO user_state_intent(entity_key,entity_json,value_json,seed) VALUES(?,?,?,0)").run(userStateEntityKey(old.entity), JSON.stringify(old.entity), JSON.stringify(old.value));
    await bindUserStateCurrentWorkspace(binding);
    const exported = await exportUserStateCurrentSnapshot(binding);
    expect(exported.items.filter(item => item.entity.kind === "reading")).toEqual([{
      entity: { kind: "reading", work, chapter: { chapterPath: "/chapter/1", name: "One" } }, value: readingValue(100, 20),
    }]);
    const category = exported.items.find(item => item.entity.kind === "category")!;
    expect(category.value).toEqual({ name: "Completed", sort: 0, deleted: false });
    expect(category.entity).toEqual({ kind: "category", categoryId: await currentCategoryId("Completed") });
    expect(JSON.stringify(exported)).not.toMatch(/operationId|baseRevision|acknowledged|sequence/);
    expect(active.sql.prepare("SELECT count(*) AS count FROM user_state_operation").get()).toEqual({ count: 0 });
    expect(active.sql.prepare("SELECT count(*) AS count FROM user_state_intent").get()).toEqual({ count: 1 });
  });

  it.each([false, true])("preserves precise local reader positions when the first DB fallback returns unchanged (renamed: %s)", async renamed => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE chapter SET progress=35,read_at=10");
    const saved = savedReaderPosition();
    const exported = await exportUserStateCurrentSnapshot(binding);
    const resume = exported.items.find(item => item.entity.kind === "resume")!;
    expect(resume.value).toEqual({ chapter: { chapterPath: "/chapter/1", name: "One" }, anchor: null, openedAt: 10 });
    if (renamed) (resume.value as UserStateValueMap["resume"]).chapter!.name = "A renamed chapter";
    const applyToReader = vi.fn((effects: { resumes: Parameters<ReturnType<typeof useReaderStore.getState>["applySharedResume"]>[0][] }) => {
      for (const effect of effects.resumes) useReaderStore.getState().applySharedResume(effect);
    });
    const unsubscribe = subscribeUserStateApplied(applyToReader);
    try {
      const result = await applyUserStateCurrentSnapshot(binding, exported);
      expect(result.resumes).toEqual([]);
      expect(result.changed).toBe(false);
      expect(applyToReader).not.toHaveBeenCalled();
      expect(currentReaderPosition()).toEqual(saved);
      const persisted = JSON.parse(readerStorage.values.get("reader-settings")!) as { state: typeof saved };
      expect(persisted.state).toMatchObject(saved);
    } finally { unsubscribe(); }
  });

  it.each([20, 40])("compares an incoming resume with all public local chapters and only applies a newer position (%s)", async openedAt => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE chapter SET progress=35,read_at=10; INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,read_at) VALUES(12,1,'/chapter/2','Two','2',2,50,30)");
    const saved = savedReaderPosition(12);
    const unsubscribe = subscribeUserStateApplied(effects => {
      for (const effect of effects.resumes) useReaderStore.getState().applySharedResume(effect);
    });
    try {
      const result = await applyUserStateCurrentSnapshot(binding, snapshot([{
        entity: { kind: "resume", work },
        value: { chapter: { chapterPath: "/chapter/1" }, anchor: null, openedAt },
      }]));
      if (openedAt < 30) {
        expect(result.resumes).toEqual([]);
        expect(currentReaderPosition()).toEqual(saved);
        const exported = await exportUserStateCurrentSnapshot(binding);
        expect(exported.items.find(item => item.entity.kind === "resume")?.value).toMatchObject({
          chapter: { chapterPath: "/chapter/2" }, openedAt: 30,
        });
      } else {
        expect(result.resumes).toEqual([{ novelId: 1, chapterId: 11, anchor: null, openedAt: 40 }]);
        expect(useReaderStore.getState().lastReadChapterByNovel[1]).toBe(11);
        expect(useReaderStore.getState().novelPageIndexByNovel[1]).toBeUndefined();
        expect(useReaderStore.getState().chapterScrollAnchors[11]).toBeUndefined();
      }
    } finally { unsubscribe(); }
  });

  it("does not revive an explicit cleared resume from stale DB history", async () => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE chapter SET progress=35,read_at=10");
    const entity = { kind: "resume" as const, work };
    const value = { chapter: null, anchor: null, openedAt: null };
    active.sql.prepare("INSERT INTO user_state_intent(entity_key,entity_json,value_json,seed) VALUES(?,?,?,0)")
      .run(userStateEntityKey(entity), JSON.stringify(entity), JSON.stringify(value));
    const exported = await exportUserStateCurrentSnapshot(binding);
    expect(exported.items.some(item => item.entity.kind === "resume")).toBe(false);
    expect((await applyUserStateCurrentSnapshot(binding, exported)).resumes).toEqual([]);
    expect(active.sql.prepare("SELECT value_json FROM user_state_intent WHERE entity_key=?").get(userStateEntityKey(entity)))
      .toEqual({ value_json: JSON.stringify(value) });
  });

  it("does not publish or compare a newer private DB chapter as a public resume", async () => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE chapter SET progress=35,read_at=10; INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,read_at) VALUES(12,1,'/chapter/2','Two','2',2,95,99)");
    const key = userStateEntityKey(reading("/chapter/2", 0).entity);
    active.sql.prepare("INSERT INTO user_state_private(entity_key,public_value_json) VALUES(?,?)").run(key, JSON.stringify(readingValue(0)));
    const exported = await exportUserStateCurrentSnapshot(binding);
    expect(exported.items.find(item => item.entity.kind === "resume")?.value).toMatchObject({
      chapter: { chapterPath: "/chapter/1" }, openedAt: 10,
    });
    const result = await applyUserStateCurrentSnapshot(binding, snapshot([{
      entity: { kind: "resume", work }, value: { chapter: { chapterPath: "/chapter/1" }, anchor: null, openedAt: 20 },
    }]));
    expect(result.resumes).toEqual([{ novelId: 1, chapterId: 11, anchor: null, openedAt: 20 }]);
    expect(active.sql.prepare("SELECT progress,read_at FROM chapter WHERE id=12").get()).toEqual({ progress: 95, read_at: 99 });
  });

  it.each([false, true])("keeps a retained composition row's anchor but retargets a genuinely replaced chapter (replacement: %s)", async replacement => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE chapter SET progress=35,read_at=10");
    const saved = savedReaderPosition();
    const path = replacement ? "norea-composed:entry-1" : "/chapter/1";
    const composition: ChapterCompositionV1 = { version: 1, updatedAt: 10, entries: [{
      id: "entry-1", path, storageChapterNumber: replacement ? "2" : "1", primarySource: 0,
      user: { included: true, order: 1, name: "Renamed", chapterNumber: null },
      sources: [{ pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/chapter/1",
        chapterNumber: "1", name: "One", position: 1, page: "1", contentType: "html", releaseTime: null }],
    }] };
    const unsubscribe = subscribeUserStateApplied(effects => {
      for (const effect of effects.resumes) useReaderStore.getState().applySharedResume(effect);
    });
    try {
      const result = await applyUserStateCurrentSnapshot(binding, snapshot([
        { entity: { kind: "composition", work }, value: { composition } },
        { entity: { kind: "resume", work }, value: {
          chapter: { chapterPath: path, name: "Renamed", ...(replacement ? { compositionEntryId: "entry-1" } : {}) },
          anchor: null, openedAt: 10,
        } },
      ]));
      expect(result.missingMetadataCount).toBe(0);
      const chapter = active.sql.prepare("SELECT id,progress,read_at FROM chapter WHERE path=?").get(path) as { id: number; progress: number; read_at: number };
      expect(chapter).toMatchObject({ progress: 35, read_at: 10 });
      if (replacement) {
        expect(chapter.id).not.toBe(11);
        expect(result.resumes).toEqual([{ novelId: 1, chapterId: chapter.id, anchor: null, openedAt: 10 }]);
        expect(useReaderStore.getState().lastReadChapterByNovel[1]).toBe(chapter.id);
        expect(useReaderStore.getState().novelPageIndexByNovel[1]).toBeUndefined();
        expect(useReaderStore.getState().chapterScrollAnchors[chapter.id]).toBeUndefined();
      } else {
        expect(chapter.id).toBe(11);
        expect(result.resumes).toEqual([]);
        expect(currentReaderPosition()).toEqual(saved);
      }
    } finally { unsubscribe(); }
  });

  it.each([false, true])("clears an old body's precise anchor when a retained synthetic row selects a different primary source (captured: %s)", async captured => {
    await bindUserStateCurrentWorkspace(binding);
    const path = "norea-composed:entry-1";
    active.sql.prepare("UPDATE chapter SET path=?,progress=35,read_at=10").run(path);
    const saved = savedReaderPosition();
    const composition: ChapterCompositionV1 = { version: 1, updatedAt: 10, entries: [{
      id: "entry-1", path, storageChapterNumber: "1", primarySource: 0,
      user: { included: true, order: 1, name: null, chapterNumber: null },
      sources: ["/source/body-a", "/source/body-b"].map(chapterPath => ({
        pluginId: "source", novelId: "book", novelPath: "/book", chapterPath,
        chapterNumber: "1", name: "One", position: 1, page: "1", contentType: "html", releaseTime: null,
      })),
    }] };
    active.sql.prepare("INSERT INTO novel_chapter_composition(novel_id,payload) VALUES(?,?)").run(1, JSON.stringify(composition));
    if (captured) {
      const entity = { kind: "resume" as const, work };
      const { novelId: _novelId, ...anchor } = saved.chapterScrollAnchors[11];
      active.sql.prepare("INSERT INTO user_state_intent(entity_key,entity_json,value_json,seed) VALUES(?,?,?,0)")
        .run(userStateEntityKey(entity), JSON.stringify(entity), JSON.stringify({
          chapter: { chapterPath: path, compositionEntryId: "entry-1" }, anchor, openedAt: 10,
        }));
    }
    composition.updatedAt = 20;
    composition.entries[0].primarySource = 1;
    const unsubscribe = subscribeUserStateApplied(effects => {
      for (const effect of effects.resumes) useReaderStore.getState().applySharedResume(effect);
    });
    try {
      const result = await applyUserStateCurrentSnapshot(binding, snapshot([
        { entity: { kind: "composition", work }, value: { composition } },
        { entity: { kind: "resume", work }, value: {
          chapter: { chapterPath: path, compositionEntryId: "entry-1", name: "One" }, anchor: null, openedAt: 10,
        } },
      ]));
      expect(result.missingMetadataCount).toBe(0);
      expect(active.sql.prepare("SELECT id,path FROM chapter").get()).toEqual({ id: 11, path });
      expect(result.resumes).toEqual([{ novelId: 1, chapterId: 11, anchor: null, openedAt: 10 }]);
      expect(useReaderStore.getState().lastReadChapterByNovel).toEqual(saved.lastReadChapterByNovel);
      expect(useReaderStore.getState().novelPageIndexByNovel[1]).toBeUndefined();
      expect(useReaderStore.getState().chapterScrollAnchors[11]).toBeUndefined();
      const exported = await exportUserStateCurrentSnapshot(binding);
      expect((exported.items.find(item => item.entity.kind === "resume")?.value as UserStateValueMap["resume"]).anchor).toBeNull();
      expect(active.sql.prepare("SELECT COUNT(*) AS count FROM user_state_operation").get()).toEqual({ count: 0 });
    } finally { unsubscribe(); }
  });

  it("only clears the changed chapter's legacy resume leaf when a newer stable-ID leaf points elsewhere", async () => {
    await bindUserStateCurrentWorkspace(binding);
    const path = "norea-composed:entry-1";
    active.sql.prepare("UPDATE chapter SET path=?,progress=35,read_at=10").run(path);
    active.sql.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,read_at) VALUES(12,1,'/chapter/2','Two','2',2,50,20)");
    const source = (chapterPath: string) => ({
      pluginId: "source", novelId: "book", novelPath: "/book", chapterPath,
      chapterNumber: "1", name: "One", position: 1, page: "1", contentType: "html" as const, releaseTime: null,
    });
    const composition: ChapterCompositionV1 = { version: 1, updatedAt: 10, entries: [
      { id: "entry-1", path, storageChapterNumber: "1", primarySource: 0,
        user: { included: true, order: 1, name: null, chapterNumber: null }, sources: [source("/body/a"), source("/body/b")] },
      { id: "entry-2", path: "/chapter/2", storageChapterNumber: "2", primarySource: 0,
        user: { included: true, order: 2, name: null, chapterNumber: null }, sources: [source("/chapter/2")] },
    ] };
    active.sql.prepare("INSERT INTO novel_chapter_composition(novel_id,payload) VALUES(?,?)").run(1, JSON.stringify(composition));
    const legacyEntity = { kind: "resume" as const, work: { ...work, sourceNovelId: null } };
    const currentEntity = { kind: "resume" as const, work };
    const anchor = { segmentIndex: 2, segmentCount: 10, offset: 0.25, progress: 35, savedAt: 10_000 };
    const legacyValue = { chapter: { chapterPath: path, compositionEntryId: "entry-1" }, anchor, openedAt: 10 };
    const currentValue = { chapter: { chapterPath: "/chapter/2" }, anchor: { ...anchor, savedAt: 20_000 }, openedAt: 20 };
    for (const [entity, value] of [[legacyEntity, legacyValue], [currentEntity, currentValue]] as const) {
      active.sql.prepare("INSERT INTO user_state_intent(entity_key,entity_json,value_json,seed) VALUES(?,?,?,0)")
        .run(userStateEntityKey(entity), JSON.stringify(entity), JSON.stringify(value));
    }
    composition.updatedAt = 20;
    composition.entries[0].primarySource = 1;
    const result = await applyUserStateCurrentSnapshot(binding, snapshot([
      { entity: { kind: "composition", work }, value: { composition } },
      { entity: currentEntity, value: { ...legacyValue, anchor: null } },
    ]));
    expect(result.resumes).toEqual([]);
    expect(active.sql.prepare("SELECT value_json FROM user_state_intent WHERE entity_key=?").get(userStateEntityKey(currentEntity)))
      .toEqual({ value_json: JSON.stringify(currentValue) });
    const legacy = active.sql.prepare("SELECT value_json FROM user_state_intent WHERE entity_key=?").get(userStateEntityKey(legacyEntity)) as { value_json: string };
    expect(JSON.parse(legacy.value_json)).toEqual({ ...legacyValue, anchor: null });
    const exported = await exportUserStateCurrentSnapshot(binding);
    expect(exported.items.find(item => item.entity.kind === "resume")?.value).toEqual(currentValue);
  });

  it("maps exact portable identities across colliding integer IDs and keeps unrelated categories and data", async () => {
    const recipient = fixture();
    addWork(recipient, 1, 11, { ...work, sourceNovelId: "other", novelPath: "/other" });
    addWork(recipient, 99, 88, { ...work, sourceNovelId: "BOOK", novelPath: "/redirected" });
    recipient.sql.exec("INSERT INTO category(id,name,sort) VALUES(7,'Other category',3),(55,'Favorites',7); UPDATE chapter SET content_bytes=777,is_downloaded=1");
    active = recipient; await bindUserStateCurrentWorkspace(binding);
    const categoryId = await currentCategoryId("Favorites");
    await applyUserStateCurrentSnapshot(binding, snapshot([
      { entity: { kind: "category", categoryId }, value: { name: "Favorites", sort: 2, deleted: false } },
      { entity: { kind: "membership", work, categoryId }, value: { included: true } },
      { entity: { kind: "library", work }, value: { inLibrary: true, addedAt: 10 } },
      reading("/chapter/1", 73),
    ]));
    expect(recipient.sql.prepare("SELECT id,progress,content_bytes,is_downloaded FROM chapter ORDER BY id").all()).toEqual([
      { id: 11, progress: 0, content_bytes: 777, is_downloaded: 1 }, { id: 88, progress: 73, content_bytes: 777, is_downloaded: 1 },
    ]);
    expect(recipient.sql.prepare("SELECT id,name FROM category ORDER BY id").all()).toEqual([{ id: 7, name: "Other category" }, { id: 55, name: "Favorites" }]);
    expect(recipient.sql.prepare("SELECT novel_id,category_id FROM novel_category").all()).toEqual([{ novel_id: 99, category_id: 55 }]);
    expect(recipient.sql.prepare("SELECT count(*) AS count FROM user_state_intent").get()).toEqual({ count: 0 });
  });

  it("never lets an older snapshot regress a newer read and merges undated progress monotonically", async () => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE chapter SET progress=80,read_at=20");
    await applyUserStateCurrentSnapshot(binding, snapshot([reading("/chapter/1", 100, work, 10)]));
    expect(active.sql.prepare("SELECT progress,read_at FROM chapter").get()).toEqual({ progress: 80, read_at: 20 });
    await applyUserStateCurrentSnapshot(binding, snapshot([reading("/chapter/1", 30, work, 30)]));
    expect(active.sql.prepare("SELECT progress,read_at FROM chapter").get()).toEqual({ progress: 30, read_at: 30 });
    active.sql.exec("UPDATE chapter SET progress=80,read_at=NULL");
    await applyUserStateCurrentSnapshot(binding, snapshot([reading("/chapter/1", 20)]));
    expect(active.sql.prepare("SELECT progress,read_at FROM chapter").get()).toEqual({ progress: 80, read_at: null });
  });

  it("exports and merges the last public tuple without exposing or overwriting an incognito position", async () => {
    await bindUserStateCurrentWorkspace(binding);
    const key = userStateEntityKey(reading("/chapter/1", 0).entity);
    active.sql.prepare("INSERT INTO user_state_private(entity_key,public_value_json) VALUES(?,?)").run(key, JSON.stringify(readingValue(35, 10)));
    active.sql.exec("UPDATE chapter SET progress=0,unread=1,read_at=NULL");
    let exported = await exportUserStateCurrentSnapshot(binding);
    expect(exported.items.find(item => item.entity.kind === "reading")?.value).toEqual(readingValue(35, 10));
    expect(exported.items.some(item => item.entity.kind === "resume")).toBe(false);
    active.sql.exec("UPDATE chapter SET progress=95,read_at=99");
    await applyUserStateCurrentSnapshot(binding, snapshot([reading("/chapter/1", 50, work, 20)]));
    expect(active.sql.prepare("SELECT progress,read_at FROM chapter").get()).toEqual({ progress: 95, read_at: 99 });
    exported = await exportUserStateCurrentSnapshot(binding);
    expect(exported.items.find(item => item.entity.kind === "reading")?.value).toEqual(readingValue(50, 20));
    expect(exported.items.some(item => item.entity.kind === "resume")).toBe(false);
  });

  it("keeps absent exact chapter state in one cached snapshot and retries it when that work's metadata arrives", async () => {
    await bindUserStateCurrentWorkspace(binding);
    const otherWork = { ...work, sourceNovelId: "absent", novelPath: "/absent" };
    const original = snapshot([reading("/chapter/1", 25), reading("/chapter/2", 65), reading("/chapter/1", 99, otherWork)]);
    const first = await applyUserStateCurrentSnapshot(binding, original);
    expect(first.missingMetadataCount).toBe(2);
    expect(active.sql.prepare("SELECT progress FROM chapter").get()).toEqual({ progress: 25 });
    active.sql.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(12,1,'/chapter/2','Two','2',2)");
    await tx(active, db => deferUserStateForNovelInDb(db, 1));
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT progress FROM chapter WHERE id=12").get()).toEqual({ progress: 65 });
    expect((await getUserStateCurrentStatus(binding.serverUrl)).missingMetadataCount).toBe(1);
    const cache = active.sql.prepare("SELECT payload FROM content_sync_cache WHERE cache_key=?").get(currentCacheKey(binding)) as { payload: string };
    expect(JSON.parse(cache.payload).snapshot).toEqual(original);
    expect(active.sql.prepare("SELECT count(*) AS count FROM user_state_record").get()).toEqual({ count: 0 });
  });

  it("serializes a cached metadata retry with a newer full snapshot without restoring the old cache", async () => {
    await bindUserStateCurrentWorkspace(binding);
    const previous = snapshot([reading("/chapter/2", 65)]);
    const newer = snapshot([reading("/chapter/2", 65), reading("/chapter/3", 90)]);
    await applyUserStateCurrentSnapshot(binding, previous);
    active.sql.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(12,1,'/chapter/2','Two','2',2)");
    const originalSelect = active.db.select.bind(active.db);
    let signalRead: () => void = () => undefined;
    let releaseRead: () => void = () => undefined;
    const readStarted = new Promise<void>(resolve => { signalRead = resolve; });
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve; });
    let paused = false;
    const intercepted = vi.spyOn(active.db, "select").mockImplementation(async (query: string, values?: unknown[]) => {
      const result = await originalSelect(query, values);
      if (!paused && query === "SELECT payload FROM content_sync_cache WHERE cache_key=$1") {
        paused = true; signalRead(); await readReleased;
      }
      return result;
    });
    await tx(active, db => deferUserStateForNovelInDb(db, 1));
    await readStarted;
    const publishing = applyUserStateCurrentSnapshot(binding, newer);
    // A retry has read its previous snapshot but holds no SQLite transaction while the new publication waits.
    await new Promise(resolve => setTimeout(resolve, 30));
    releaseRead();
    await Promise.all([publishing, waitForUserStateDeferredApply()]);
    intercepted.mockRestore();
    const cached = active.sql.prepare("SELECT payload FROM content_sync_cache WHERE cache_key=?").get(currentCacheKey(binding)) as { payload: string };
    expect(JSON.parse(cached.payload).snapshot).toEqual(newer);
    active.sql.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(13,1,'/chapter/3','Three','3',3)");
    await tx(active, db => deferUserStateForNovelInDb(db, 1));
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT progress FROM chapter WHERE id=13").get()).toEqual({ progress: 90 });
  });

  it("preserves the restore fence and the old journal while reconnecting through the current snapshot", async () => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE user_state_restore_state SET paused=1,restored=1");
    await expect(exportUserStateCurrentSnapshot(binding)).rejects.toThrow("paused");
    await expect(applyUserStateCurrentSnapshot(binding, snapshot([reading("/chapter/1", 80)]))).rejects.toThrow("paused");
    expect(active.sql.prepare("SELECT progress FROM chapter").get()).toEqual({ progress: 0 });
    await resumeUserStateAfterRestore();
    await applyUserStateCurrentSnapshot(binding, snapshot([reading("/chapter/1", 80)]));
    expect(active.sql.prepare("SELECT restored FROM user_state_restore_state").get()).toEqual({ restored: 1 });
    expect(active.sql.prepare("SELECT progress FROM chapter").get()).toEqual({ progress: 80 });
  });

  it("validates the entire incoming snapshot before changing existing values", async () => {
    await bindUserStateCurrentWorkspace(binding);
    const invalid = snapshot([reading("/chapter/1", 80), { entity: { kind: "library", work }, value: { inLibrary: false, addedAt: null } }]);
    await expect(applyUserStateCurrentSnapshot(binding, invalid)).rejects.toThrow("additive");
    expect(active.sql.prepare("SELECT progress FROM chapter").get()).toEqual({ progress: 0 });
    await expect(applyUserStateCurrentSnapshot(binding, snapshot([reading("/chapter/1", 10), reading("/chapter/1", 80)]))).rejects.toThrow("duplicate");
    const conflict = { ...work, sourceNovelId: "different" };
    const result = await applyUserStateCurrentSnapshot(binding, snapshot([{ entity: { kind: "library", work: conflict }, value: { inLibrary: true, addedAt: null } }]));
    expect(result.missingMetadataCount).toBe(1);
    expect(active.sql.prepare("SELECT source_novel_id,in_library FROM novel").get()).toEqual({ source_novel_id: "book", in_library: 0 });
  });

  it("holds retired source identities in bulk through completion and honors the server scope and an explicit revocation", async () => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE novel SET in_library=1; UPDATE chapter SET progress=65");
    const source = { pluginId: work.pluginId, novelId: work.sourceNovelId, novelPath: work.novelPath };
    active.sql.prepare("INSERT INTO content_sync_cache(cache_key,payload) VALUES(?,?)").run("norea-content-novel-migration:old-operation", JSON.stringify({
      operationId: "old-operation", serverUrl: binding.serverUrl, source, status: "completed",
    }));
    const exported = await exportUserStateCurrentSnapshot(binding);
    expect(exported.items.filter(item => "work" in item.entity)).toEqual([]);
    active.sql.exec("DELETE FROM novel");
    const retired = snapshot([{ entity: { kind: "library", work }, value: { inLibrary: true, addedAt: 10 } }, reading("/chapter/1", 65)]);
    const held = await applyUserStateCurrentSnapshot(binding, retired);
    expect(held.missingMetadataCount).toBe(2);
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM novel").get()).toEqual({ count: 0 });
    const otherBinding = { ...binding, serverUrl: "https://another.example" };
    setUserStateCurrentServer(otherBinding.serverUrl);
    await bindUserStateCurrentWorkspace(otherBinding);
    await applyUserStateCurrentSnapshot(otherBinding, retired);
    expect(active.sql.prepare("SELECT source_novel_id FROM novel").get()).toEqual({ source_novel_id: "book" });
    active.sql.exec("DELETE FROM novel");
    setUserStateCurrentServer(binding.serverUrl);
    active.sql.prepare("INSERT INTO content_sync_cache(cache_key,payload) VALUES(?,?)").run("norea-content-incoming-migration:revocation", JSON.stringify({
      operationId: "modern-operation", serverUrl: binding.serverUrl, source, status: "inactive", lineage: { legacyOperationId: "old-operation" },
    }));
    await applyUserStateCurrentSnapshot(binding, retired);
    expect(active.sql.prepare("SELECT source_novel_id FROM novel").get()).toEqual({ source_novel_id: "book" });
  });

  it("preserves raw source order and storage ownership while applying the user's chapter order", async () => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(12,1,'/chapter/2','Two','2',2); UPDATE chapter SET content_bytes=777,is_downloaded=1");
    const composition: ChapterCompositionV1 = { version: 1, updatedAt: 10, entries: [1, 2].map(number => ({
      id: "entry-" + number, path: "/chapter/" + number, storageChapterNumber: String(number), primarySource: 0,
      user: { included: true, order: 3 - number, name: null, chapterNumber: String(100 + number) },
      sources: [{ pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/chapter/" + number,
        chapterNumber: String(number), name: number === 1 ? "One" : "Two", position: number, page: "1", contentType: "html", releaseTime: null }],
    })) };
    const result = await applyUserStateCurrentSnapshot(binding, snapshot([
      { entity: { kind: "composition", work }, value: { composition } }, reading("/chapter/1", 75),
    ]));
    expect(result.missingMetadataCount).toBe(0);
    expect(active.sql.prepare("SELECT id,chapter_number,position,content_bytes,is_downloaded FROM chapter ORDER BY id").all()).toEqual([
      { id: 11, chapter_number: "1", position: 2, content_bytes: 777, is_downloaded: 1 },
      { id: 12, chapter_number: "2", position: 1, content_bytes: 777, is_downloaded: 1 },
    ]);
    const exported = await exportUserStateCurrentSnapshot(binding);
    expect((exported.items.find(item => item.entity.kind === "composition")?.value as UserStateValueMap["composition"]).composition.entries.map(entry => entry.sources[0].position)).toEqual([1, 2]);
  });

  it.each([false, true])("remaps the current public resume without replaying settled operations (same target body: %s)", async sameTargetBody => {
    await bindUserStateCurrentWorkspace(binding);
    const target = { ...work, sourceNovelId: "target", novelPath: "/target" };
    addWork(active, 2, 22, target);
    active.sql.exec("UPDATE chapter SET progress=95,read_at=99 WHERE id=22; UPDATE chapter SET path='/target/current' WHERE id=22");
    const privateKey = userStateEntityKey(reading("/chapter/1", 0).entity);
    active.sql.prepare("INSERT INTO user_state_private(entity_key,public_value_json) VALUES(?,?)").run(privateKey, JSON.stringify(readingValue(35, 10)));
    const anchor = { segmentIndex: 3, segmentCount: 10, offset: 0.25, progress: 35, savedAt: 20_000 };
    const resumeEntity = { kind: "resume" as const, work: sameTargetBody ? target : work };
    const resumeValue = { chapter: { chapterPath: sameTargetBody ? "/target/old" : "/chapter/1" }, anchor, openedAt: 20 };
    if (sameTargetBody) {
      active.sql.prepare("INSERT INTO content_sync_cache(cache_key,payload) VALUES(?,?)").run(currentStatusKey(binding), JSON.stringify({
        resumes: [{ entity: resumeEntity, value: resumeValue }], missingMetadataCount: 0,
      }));
    } else {
      active.sql.prepare("INSERT INTO user_state_intent(entity_key,entity_json,value_json,seed) VALUES(?,?,?,0)").run(userStateEntityKey(resumeEntity), JSON.stringify(resumeEntity), JSON.stringify(resumeValue));
      active.sql.prepare("INSERT INTO user_state_progress(namespace,entity_key,local_sequence,acknowledged_sequence) VALUES(?,?,1,1)").run(JSON.stringify([binding.serverUrl, binding.workspaceId, binding.epoch]), userStateEntityKey(resumeEntity));
    }
    const stale = reading("/chapter/1", 5);
    active.sql.prepare("INSERT INTO user_state_intent(entity_key,entity_json,value_json,seed) VALUES(?,?,?,0)").run(userStateEntityKey(stale.entity), JSON.stringify(stale.entity), JSON.stringify(stale.value));
    const staleSequence = (active.sql.prepare("SELECT sequence FROM user_state_intent WHERE entity_key=?").get(userStateEntityKey(stale.entity)) as { sequence: number }).sequence;
    active.sql.prepare("INSERT INTO user_state_progress(namespace,entity_key,local_sequence,acknowledged_sequence) VALUES(?,?,?,0)").run(JSON.stringify([binding.serverUrl, binding.workspaceId, binding.epoch]), userStateEntityKey(stale.entity), staleSequence);
    const effects = await tx(active, db => remapPendingUserStateInDb(db, 1, 2, { 11: 22 }, sameTargetBody ? { "/target/current": "/target/old" } : {}));
    expect(effects.resumes).toEqual([{ novelId: 2, chapterId: 22, openedAt: 20, anchor: sameTargetBody ? anchor : null }]);
    expect(active.sql.prepare("SELECT progress,read_at FROM chapter WHERE id=22").get()).toEqual({ progress: 95, read_at: 99 });
    const targetPrivateKey = userStateEntityKey({ kind: "reading", work: target, chapter: { chapterPath: "/target/current" } });
    expect(active.sql.prepare("SELECT public_value_json FROM user_state_private WHERE entity_key=?").get(targetPrivateKey)).toEqual({ public_value_json: JSON.stringify(readingValue(35, 10)) });
    const exported = await exportUserStateCurrentSnapshot(binding);
    expect(exported.items.find(item => item.entity.kind === "resume" && item.entity.work.sourceNovelId === "target")?.value).toEqual({
      chapter: { chapterPath: "/target/current", name: "One" }, openedAt: 20, anchor: sameTargetBody ? anchor : null,
    });
  });

  it("retains unresolved folder state locally and exports it only after exact metadata supplies the path", async () => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("UPDATE chapter SET path='norea-folder:1',progress=42");
    expect((await exportUserStateCurrentSnapshot(binding)).items.some(item => item.entity.kind === "reading")).toBe(false);
    expect((await getUserStateCurrentStatus(binding.serverUrl)).missingMetadataCount).toBe(1);
    expect(active.sql.prepare("SELECT progress FROM chapter").get()).toEqual({ progress: 42 });
    active.sql.exec("UPDATE chapter SET path='/chapter/confirmed'");
    expect((await exportUserStateCurrentSnapshot(binding)).items.find(item => item.entity.kind === "reading")).toMatchObject({
      entity: { chapter: { chapterPath: "/chapter/confirmed" } }, value: { progress: 42 },
    });
    expect((await getUserStateCurrentStatus(binding.serverUrl)).missingMetadataCount).toBe(0);
  });

  it("uses a bounded number of actual SQLite bridge calls for ten thousand states with delayed bridge responses", async () => {
    await bindUserStateCurrentWorkspace(binding);
    active.sql.exec("DELETE FROM chapter");
    const count = 10_000;
    const rows = Array.from({ length: count }, (_, index) => ({ id: index + 1, path: "/chapter/" + (index + 1) }));
    active.sql.prepare("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) SELECT json_extract(value,'$.id'),1,json_extract(value,'$.path'),'Chapter',CAST(json_extract(value,'$.id') AS TEXT),json_extract(value,'$.id') FROM json_each(?)").run(JSON.stringify(rows));
    const incoming = snapshot(rows.map(row => reading(row.path, 75, work, 20)));
    active.delayMs = 2; active.calls = 0;
    const started = performance.now();
    const result = await applyUserStateCurrentSnapshot(binding, incoming);
    const applyCalls = active.calls;
    const applyElapsedMs = Math.round(performance.now() - started);
    expect(result.missingMetadataCount).toBe(0);
    expect(applyCalls).toBeLessThanOrEqual(35);
    expect(active.sql.prepare("SELECT COUNT(*) AS count,MIN(progress) AS progress FROM chapter").get()).toEqual({ count, progress: 75 });
    active.calls = 0;
    const exported = await exportUserStateCurrentSnapshot(binding);
    const exportCalls = active.calls;
    expect(exportCalls).toBeLessThanOrEqual(18);
    expect(exported.items.filter(item => item.entity.kind === "reading")).toHaveLength(count);
    active.calls = 0;
    const unchanged = await applyUserStateCurrentSnapshot(binding, incoming);
    expect(unchanged.changed).toBe(false);
    expect(active.calls).toBeLessThanOrEqual(33);
    console.info("current-state bulk benchmark", JSON.stringify({ count, bridgeDelayMs: active.delayMs, applyCalls, exportCalls, applyElapsedMs }));
  }, 60_000);
});
