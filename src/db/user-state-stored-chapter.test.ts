import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
}));
vi.mock("../lib/chapter-content/storage-platform", () => ({
  inspectChapterPayloadInventory: mocks.inspect,
}));

import {
  portableStoredChapterReferenceInDb,
  portableStoredUserStateIntentInDb,
  resolveStoredChapterReferenceInDb,
} from "./user-state-stored-chapter";
import { storedChapterPath } from "../lib/user-state/stored-chapter";
import type { UserStateDb } from "./user-state-core";

const hash = "a".repeat(64);
const work = { pluginId: "source", sourceNovelId: "book", novelPath: "/book", name: "Book" };
let sqlite: DatabaseSync;
let db: UserStateDb;

function params(values: SQLInputValue[]) {
  return Object.fromEntries(values.map((value, index) => ["$" + (index + 1), value]));
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE novel (
      id INTEGER PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      source_novel_id TEXT,
      path TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE chapter (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      chapter_number TEXT,
      position INTEGER NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'html',
      stored_content_type TEXT
    );
    CREATE TABLE novel_chapter_composition (novel_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    INSERT INTO novel(id,plugin_id,source_novel_id,path,name)
      VALUES(1,'source','book','/book','Book');
    INSERT INTO chapter(id,novel_id,path,name,chapter_number,position)
      VALUES(11,1,'norea-folder:1','One','1',1);
  `);
  db = {
    select: async <T>(query: string, values: unknown[] = []) =>
      sqlite.prepare(query).all(params(values as SQLInputValue[])) as T,
    execute: async (query: string, values: unknown[] = []) => {
      const result = sqlite.prepare(query).run(params(values as SQLInputValue[]));
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as UserStateDb;
  mocks.inspect.mockResolvedValue({
    body: { sha256: hash, bytes: 100 },
    expectedAssetKeys: [],
    storedAssets: [],
  });
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

describe("delta stored chapter identity", () => {
  it("publishes and resolves a recovered folder only through its exact stored payload", async () => {
    const local = { chapterPath: "norea-folder:1", name: "One" };
    const portable = await portableStoredChapterReferenceInDb(db, work, local);
    expect(portable).toEqual({ chapterPath: storedChapterPath("1", hash), name: "One" });
    expect(await resolveStoredChapterReferenceInDb(db, 1, portable)).toBe(11);
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
  });



  it("upgrades a real Android text-only inventory without a media manifest", async () => {
    mocks.inspect.mockResolvedValue({
      body: { sha256: hash, bytes: 100 },
      expectedAssetKeys: null,
      storedAssets: [],
      fingerprint: "legacy-text",
      payloadBytes: 100,
      contentBytes: 100,
      mediaBytes: 0,
      mediaComplete: true,
    });
    expect(await portableStoredChapterReferenceInDb(db, work, {
      chapterPath: "norea-folder:1", name: "One",
    })).toEqual({ chapterPath: storedChapterPath("1", hash), name: "One" });
  });

  it("upgrades reading and resume wire values without rewriting unrelated intent fields", async () => {
    const reading = await portableStoredUserStateIntentInDb(db, {
      entity: { kind: "reading", work, chapter: { chapterPath: "norea-folder:1", name: "One" } },
      value: { progress: 82, unread: true, readAt: 10 },
    });
    expect(reading.entity).toMatchObject({
      kind: "reading",
      chapter: { chapterPath: storedChapterPath("1", hash) },
    });

    const resume = await portableStoredUserStateIntentInDb(db, {
      entity: { kind: "resume", work },
      value: { chapter: { chapterPath: "norea-folder:1", name: "One" }, anchor: null, openedAt: 11 },
    });
    expect(resume.value).toMatchObject({
      chapter: { chapterPath: storedChapterPath("1", hash) },
      anchor: null,
      openedAt: 11,
    });
  });

  it("rejects a stored identity when the receiver body differs", async () => {
    const path = storedChapterPath("1", hash)!;
    mocks.inspect.mockResolvedValue({
      body: { sha256: "b".repeat(64), bytes: 100 },
      expectedAssetKeys: [],
      storedAssets: [],
    });
    expect(await resolveStoredChapterReferenceInDb(db, 1, { chapterPath: path, name: "One" })).toBeNull();
  });

  it("does not infer portable ownership for a composed work", async () => {
    sqlite.exec("INSERT INTO novel_chapter_composition(novel_id,payload) VALUES(1,'{}')");
    const local = { chapterPath: "norea-folder:1", name: "One" };
    expect(await portableStoredChapterReferenceInDb(db, work, local)).toEqual(local);
    expect(await resolveStoredChapterReferenceInDb(db, 1, {
      chapterPath: storedChapterPath("1", hash)!,
      name: "One",
    })).toBeNull();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous number fallback instead of guessing a chapter", async () => {
    sqlite.exec(`
      UPDATE chapter SET path='/provider/one' WHERE id=11;
      INSERT INTO chapter(id,novel_id,path,name,chapter_number,position)
        VALUES(12,1,'/provider/one-copy','One copy','1',2);
    `);
    expect(await resolveStoredChapterReferenceInDb(db, 1, {
      chapterPath: storedChapterPath("1", hash)!,
      name: "One",
    })).toBeNull();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});
