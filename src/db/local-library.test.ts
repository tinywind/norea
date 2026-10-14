import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChapterStorageTransferEntry, ChapterStorageTransferPreparation } from "../lib/chapter-storage-transfer";
import type { NovelMetadataV1 } from "../lib/work-metadata";

const storage = vi.hoisted(() => ({
  files: new Map<string, number[]>(),
  directories: {} as Record<string, string>,
  lists: 0,
  failWritePath: "",
  failPreparation: false,
  keepTarget: false,
  prepare: vi.fn(),
  finalize: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock("../lib/tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("./client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
vi.mock("../lib/novel-cover-storage", () => ({ invalidateAllNovelCoverSources: vi.fn() }));
vi.mock("../lib/chapter-storage-transfer", () => ({
  prepareChapterStorageTransfer: storage.prepare,
  finalizeChapterStorageTransfer: storage.finalize,
  rollbackChapterStorageTransfer: storage.rollback,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (_command: string, { input }: { input: {
    operation: string; path: string; body: number[];
    reset?: boolean; chapterDirectories?: Record<string, string>;
  } }) => {
    if (input.operation === "list") {
      storage.lists++;
      return { paths: [...storage.files.keys()].filter((path) => path.endsWith("/novel.json")) };
    }
    if (input.operation === "chapters") {
      storage.lists++;
      const directory = input.path.slice(0, -"novel.json".length);
      return { paths: [...storage.files.keys()].filter((path) => path.startsWith(directory) && /\/content\.(html|pdf)$/.test(path)) };
    }
    if (input.operation === "read") return { body: storage.files.get(input.path) ?? null };
    if (input.operation === "register") storage.directories = { ...(input.reset ? {} : storage.directories), ...input.chapterDirectories };
    if (input.operation === "write") {
      if (storage.failWritePath === input.path) { storage.failWritePath = ""; throw new Error("disk full"); }
      storage.files.set(input.path, input.body);
    }
    if (input.operation === "remove") storage.files.delete(input.path);
    return {};
  },
}));

import { consolidateLocalLibrary } from "./local-library";
import { initializeWorkMetadata } from "./work-metadata";
import { chapterStorageRelativeDir } from "../lib/chapter-storage-path";

let sqlite: DatabaseSync;
let db: Database;

function removeDirectory(directory: string) {
  for (const path of storage.files.keys()) {
    if (path.startsWith(`${directory}/`)) storage.files.delete(path);
  }
}

function seedNovel(id: number, path: string, name: string, contentType = "html") {
  const directory = `contents/local/${name}-${path}`;
  sqlite.prepare("INSERT INTO novel(id,plugin_id,path,name,is_local,in_library,last_read_at) VALUES($1,'local',$2,$3,1,1,$4)")
    .run({ $1: id, $2: path, $3: name, $4: id * 100 });
  sqlite.prepare(`INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,bookmark,unread,read_at,content_type,stored_content_type,is_downloaded)
    VALUES($1,$6,'norea-folder:1',$2,'1',1,$3,1,0,$4,$5,$5,1)`)
    .run({ $1: id * 10, $2: name, $3: id * 20, $4: id * 100, $5: contentType, $6: id });
  const metadata: NovelMetadataV1 = {
    schemaVersion: 1,
    identity: { pluginId: "local", novelPath: path },
    novel: { name, author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: true },
    cover: null,
  };
  storage.files.set(`${directory}/novel.json`, [...new TextEncoder().encode(JSON.stringify(metadata))]);
  storage.files.set(`${directory}/1-${name}/content.${contentType}`, [id, 2, 3]);
  storage.files.set(`${directory}/1-${name}/media.zip`, [id, 4, 5]);
  return directory;
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.files.clear(); storage.directories = {}; storage.lists = 0;
  storage.failWritePath = ""; storage.failPreparation = false; storage.keepTarget = false;
  storage.prepare.mockImplementation(async (entries: ChapterStorageTransferEntry[]): Promise<ChapterStorageTransferPreparation> => {
    if (storage.failPreparation) throw new Error("storage unavailable");
    return {
      token: "test-transfer",
      entries: entries.map((entry) => {
        const source = [...storage.files].filter(([path]) => path.startsWith(`${entry.sourceRelativeDir}/`));
        const content = source.find(([path]) => /\/content\.(html|pdf)$/.test(path));
        const keepTarget = storage.keepTarget || [...storage.files.keys()].some((path) => path.startsWith(`${entry.targetRelativeDir}/`) && /\/content\.(html|pdf)$/.test(path));
        if (!keepTarget && content) {
          for (const [path, bytes] of source) storage.files.set(entry.targetRelativeDir + path.slice(entry.sourceRelativeDir.length), [...bytes]);
        }
        return {
          ...entry, contentBytes: content?.[1].length ?? 0, mediaBytes: content ? 3 : 0,
          contentFile: content ? entry.targetRelativeDir + content[0].slice(entry.sourceRelativeDir.length) : null,
          replacedTarget: false,
          outcome: keepTarget ? "keptTarget" : content ? "copiedSource" : "sourceNotDownloaded",
        };
      }),
    };
  });
  storage.finalize.mockImplementation(async (preparation: ChapterStorageTransferPreparation) => {
    for (const entry of preparation.entries) if (entry.outcome === "copiedSource") removeDirectory(entry.sourceRelativeDir);
  });
  storage.rollback.mockImplementation(async (preparation: ChapterStorageTransferPreparation) => {
    for (const entry of preparation.entries) if (entry.outcome === "copiedSource") removeDirectory(entry.targetRelativeDir);
  });
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  db = {
    select: async (query: string, params: unknown[] = []) => sqlite.prepare(query).all(Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value])) as never),
    execute: async (query: string, params: unknown[] = []) => {
      const result = sqlite.prepare(query).run(Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
});

afterEach(() => sqlite.close());

it("merges local works while retaining chapter IDs, reading state, PDF bytes, and media", async () => {
  const first = seedNovel(1, "first", "First");
  const second = seedNovel(2, "second", "Second", "pdf");
  storage.files.set("C:/Books/First.md", [8, 9]);
  sqlite.exec("INSERT INTO category(id,name,sort) VALUES(20,'Favorites',20),(21,'Archive',21)");
  sqlite.exec("INSERT INTO novel_category(novel_id,category_id) VALUES(1,20),(2,21)");
  await initializeWorkMetadata(db);

  await consolidateLocalLibrary(db);

  const novel = sqlite.prepare("SELECT id,plugin_id,path,name,is_local,in_library,last_read_at FROM novel").get();
  expect(novel).toMatchObject({ plugin_id: "local", path: "local", name: "local", is_local: 1, in_library: 1, last_read_at: 200 });
  expect(sqlite.prepare("SELECT id,novel_id,progress,bookmark,unread,read_at,stored_content_type,is_downloaded FROM chapter ORDER BY id").all()).toEqual([
    { id: 10, novel_id: novel!.id, progress: 20, bookmark: 1, unread: 0, read_at: 100, stored_content_type: "html", is_downloaded: 1 },
    { id: 20, novel_id: novel!.id, progress: 40, bookmark: 1, unread: 0, read_at: 200, stored_content_type: "pdf", is_downloaded: 1 },
  ]);
  const paths = sqlite.prepare("SELECT path FROM chapter").all().map((row) => row.path);
  expect(new Set(paths).size).toBe(2);
  expect(sqlite.prepare("SELECT position,chapter_number FROM chapter ORDER BY position").all()).toEqual([
    { position: 1, chapter_number: "1" }, { position: 2, chapter_number: "2" },
  ]);
  expect(sqlite.prepare("SELECT category_id FROM novel_category ORDER BY category_id").all()).toEqual([{ category_id: 20 }, { category_id: 21 }]);
  for (const [id, extension] of [[10, "html"], [20, "pdf"]] as const) {
    const directory = chapterStorageRelativeDir({ id: Number(novel!.id) }, { id });
    expect(directory).toMatch(/^contents\/local\/local-local\//);
    expect(storage.files.get(`${directory}/content.${extension}`)).toEqual([id / 10, 2, 3]);
    expect(storage.files.get(`${directory}/media.zip`)).toEqual([id / 10, 4, 5]);
    expect(storage.directories[String(id)]).toBe(directory);
  }
  expect(storage.files.get("C:/Books/First.md")).toEqual([8, 9]);
  expect(storage.files.has(`${first}/novel.json`)).toBe(false);
  expect(storage.files.has(`${second}/novel.json`)).toBe(false);
  expect([...storage.files.keys()].filter((path) => path.endsWith("/novel.json"))).toEqual(["contents/local/local-local/novel.json"]);
});

it("reuses an existing canonical work and its chapter identity", async () => {
  seedNovel(1, "local", "local"); seedNovel(2, "second", "Second");
  await initializeWorkMetadata(db);
  await consolidateLocalLibrary(db);
  expect(sqlite.prepare("SELECT id,path,name FROM novel").all()).toEqual([{ id: 1, path: "local", name: "local" }]);
  expect(sqlite.prepare("SELECT path,position FROM chapter WHERE id=10").get()).toEqual({ path: "norea-folder:1", position: 1 });
  expect(storage.prepare.mock.calls[0]![0]).toHaveLength(1);
});

it("checks an already consolidated library without scanning storage", async () => {
  seedNovel(1, "local", "local");
  await initializeWorkMetadata(db);
  storage.lists = 0;
  const select = vi.spyOn(db, "select");
  await consolidateLocalLibrary(db);
  expect(select).toHaveBeenCalledOnce();
  expect(storage.prepare).not.toHaveBeenCalled();
  expect(storage.lists).toBe(0);
});

it("retains an orphan completed target and gives the moved chapter another directory", async () => {
  seedNovel(1, "first", "First");
  const orphan = "contents/local/local-local/1-First";
  storage.files.set(`${orphan}/content.html`, [99, 98]);
  storage.files.set(`${orphan}/media.zip`, [97, 96]);
  await initializeWorkMetadata(db);

  await consolidateLocalLibrary(db);

  const directory = chapterStorageRelativeDir({}, { id: 10 });
  expect(directory).not.toBe(orphan);
  expect(storage.files.get(`${directory}/content.html`)).toEqual([1, 2, 3]);
  expect(storage.files.get(`${orphan}/content.html`)).toEqual([99, 98]);
  expect(storage.files.get(`${orphan}/media.zip`)).toEqual([97, 96]);
});

it("clears missing-file download fields while retaining reading state and unfinished source media", async () => {
  const original = seedNovel(1, "first", "First");
  await initializeWorkMetadata(db);
  storage.files.delete(`${original}/1-First/content.html`);
  sqlite.exec("UPDATE chapter SET content_bytes=10,media_bytes=20,media_repair_needed=1,media_bytes_checked_at=123 WHERE id=10");

  await consolidateLocalLibrary(db);

  expect(sqlite.prepare(`SELECT progress,bookmark,unread,read_at,is_downloaded,stored_content_type,
    content_bytes,media_bytes,media_repair_needed,media_bytes_checked_at FROM chapter WHERE id=10`).get()).toEqual({
    progress: 20, bookmark: 1, unread: 0, read_at: 100, is_downloaded: 0, stored_content_type: null,
    content_bytes: 0, media_bytes: 0, media_repair_needed: 0, media_bytes_checked_at: null,
  });
  expect(storage.files.get(`${original}/1-First/media.zip`)).toEqual([1, 4, 5]);
});

it.each(["preparation", "metadata", "target collision", "commit"])("keeps old work data when %s fails", async (failure) => {
  seedNovel(1, "first", "First"); seedNovel(2, "second", "Second", "pdf");
  await initializeWorkMetadata(db);
  const novels = sqlite.prepare("SELECT * FROM novel ORDER BY id").all();
  const chapters = sqlite.prepare("SELECT * FROM chapter ORDER BY id").all();
  const files = new Map(storage.files);
  if (failure === "preparation") storage.failPreparation = true;
  if (failure === "metadata") storage.failWritePath = "contents/local/local-local/novel.json";
  if (failure === "target collision") storage.keepTarget = true;
  if (failure === "commit") {
    const execute = db.execute.bind(db);
    let failed = false;
    vi.spyOn(db, "execute").mockImplementation(async (query, params) => {
      if (query === "COMMIT" && !failed) { failed = true; throw new Error("commit failed"); }
      return execute(query, params);
    });
  }

  await expect(consolidateLocalLibrary(db)).rejects.toThrow();

  expect(sqlite.prepare("SELECT * FROM novel ORDER BY id").all()).toEqual(novels);
  expect(sqlite.prepare("SELECT * FROM chapter ORDER BY id").all()).toEqual(chapters);
  expect(storage.files).toEqual(files);
  expect(storage.finalize).not.toHaveBeenCalled();
  expect(storage.rollback).toHaveBeenCalledTimes(failure === "preparation" ? 0 : 1);
  expect(chapterStorageRelativeDir({ id: 1 }, { id: 10 })).toBe("contents/local/First-first/1-First");
});
