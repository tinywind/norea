import type Database from "@tauri-apps/plugin-sql";
import { beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ files: new Map<string, number[]>(), failPath: "", mutations: 0 }));
vi.mock("../tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("../../db/client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (_command: string, { input }: { input: { operation: string; path: string } }) => {
  if (input.operation === "write" || input.operation === "remove") { storage.mutations++; throw new Error("Restore attempted to change an original file"); }
  if (input.operation === "list") return { paths: [...storage.files.keys()].filter(path => path.endsWith("/novel.json")) };
  if (input.operation === "read") {
    if (input.path === storage.failPath) throw new Error("Storage unavailable");
    return { body: storage.files.get(input.path) ?? null };
  }
  const directory = input.path.slice(0, -"novel.json".length);
  if (input.operation === "cover") {
    const cover = [...storage.files.keys()].find(path => path.startsWith(directory) && /^cover\.[a-z]+$/.test(path.slice(directory.length)));
    return { cover: cover ? { fileName: cover.slice(directory.length), modifiedAt: 1 } : null };
  }
  if (input.operation === "chapters") return { paths: [...storage.files.keys()].filter(path => path.startsWith(directory) && /\/content\.(html|pdf)$/.test(path)) };
  return {};
} }));

import { prepareBackupRestore } from "./restore-plan";
import type { BackupManifest } from "./format";

const first = "contents/source/book";
const absent = "contents/local/local";
const db = { select: vi.fn() } as unknown as Database;

function save(path: string, value: unknown) {
  storage.files.set(path, [...new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value, null, 2))]);
}
function manifest(): BackupManifest {
  return { version: 2, exportedAt: 1, novels: [{ id: 1, pluginId: "source", sourceNovelId: "book", path: "/book", name: "Stale title", cover: "data:image/png;base64,c3RhbGU=",
    summary: "Stale summary", author: "Old author", artist: null, status: null, genres: null, inLibrary: true, isLocal: false,
    createdAt: 1, updatedAt: 1, libraryAddedAt: 42, lastReadAt: 73 }],
    chapters: [1, 2].map(number => ({ id: number, novelId: 1, path: `/chapter/${number}`, name: `Old chapter ${number}`, chapterNumber: String(number), position: number,
      page: "5", progress: 64, bookmark: true, unread: false, readAt: 70, isDownloaded: true, contentType: "html" as const, sourceContentType: "text" as const,
      content: null, contentBytes: 999, mediaBytes: 111, releaseTime: null, createdAt: 1, foundAt: 2, updatedAt: 3 })),
    categories: [{ id: 1, name: "Favourites", sort: 0, isSystem: false }], novelCategories: [{ id: 1, novelId: 1, categoryId: 1 }],
    repositories: [], installedPlugins: [], settings: [], vpnGateServerVerdicts: [] };
}

beforeEach(() => {
  storage.files.clear(); storage.failPath = ""; storage.mutations = 0;
  vi.mocked(db.select).mockResolvedValue([]);
  save(`${first}/novel.json`, { schemaVersion: 1, identity: { pluginId: "source", novelId: "book", novelPath: "/book" }, novel: {
    name: "Current title", summary: "Current summary", author: "Current author", rating: 4.5,
  }, cover: { fileName: "cover.png", contentType: "image/png" }, chapters: { "1": "Current opening", "2": "Only in the catalog", "3": "New chapter" } });
  storage.files.set(`${first}/cover.png`, [1, 4, 8, 0]);
  save(`${first}/1/content.html`, "<p>The original chapter</p>");
  storage.files.set(`${first}/1/media.zip`, [8, 9, 10]);
  save(`${first}/1/manifest.json`, '{ "original": true }');
  save(`${absent}/novel.json`, { identity: { pluginId: "local", novelId: "local", novelPath: "local" }, novel: { name: "Local originals", isLocal: true }, cover: null });
  save(`${absent}/1/content.pdf`, "%PDF preserved bytes");
});

it("keeps every original byte and uses current metadata while restoring library and reading state", async () => {
  const originalFiles = structuredClone(storage.files);
  const snapshot = manifest();
  const before = structuredClone(snapshot);
  const plan = await prepareBackupRestore(db, snapshot);
  expect(plan.manifest.novels[0]).toMatchObject({ id: 1, name: "Current title", summary: "Current summary", author: "Current author", rating: 4.5,
    cover: "data:image/png;base64,AQQIAA==", inLibrary: true, libraryAddedAt: 42, lastReadAt: 73 });
  expect(plan.manifest.chapters[0]).toMatchObject({ id: 1, path: "/chapter/1", name: "Current opening", isDownloaded: true,
    page: "5", progress: 64, bookmark: true, unread: false, readAt: 70 });
  expect(plan.manifest.novelCategories).toEqual(snapshot.novelCategories);
  expect(plan.cache.chapters).toContainEqual({ chapterId: 1, novelId: 1, directory: `${first}/1` });
  expect(storage.files).toEqual(originalFiles);
  expect(snapshot).toEqual(before);
  expect(storage.mutations).toBe(0);
});

it("retains works omitted from the backup without adding them to the restored library", async () => {
  const plan = await prepareBackupRestore(db, manifest());
  const retained = plan.manifest.novels.find(novel => novel.pluginId === "local")!;
  expect(retained).toMatchObject({ name: "Local originals", inLibrary: false, libraryAddedAt: null });
  expect(plan.manifest.chapters.find(chapter => chapter.novelId === retained.id)).toMatchObject({
    path: "local-folder:1", isDownloaded: true, contentType: "pdf", progress: 0, bookmark: false,
  });
  expect(plan.cache.files).toHaveLength(2);
  expect(storage.mutations).toBe(0);
});

it("preserves backed-up creation times and leaves newly recovered chapter times unknown", async () => {
  const snapshot = manifest();
  snapshot.chapters[0]!.createdAt = null;
  snapshot.chapters[0]!.foundAt = 0;

  const plan = await prepareBackupRestore(db, snapshot);

  expect(plan.manifest.chapters.slice(0, 2)).toMatchObject([
    { id: 1, createdAt: null, foundAt: 0, progress: 64, bookmark: true },
    { id: 2, createdAt: 1, foundAt: 2 },
  ]);
  expect(plan.manifest.chapters.slice(2).map(chapter => ({ path: chapter.path, createdAt: chapter.createdAt, foundAt: chapter.foundAt }))).toEqual([
    { path: "norea-folder:3", createdAt: null, foundAt: 0 },
    { path: "local-folder:1", createdAt: null, foundAt: 0 },
  ]);
  expect(storage.mutations).toBe(0);
});

it("marks only discovered complete chapter files downloaded and discards stale byte counts", async () => {
  const plan = await prepareBackupRestore(db, manifest());
  expect(plan.manifest.chapters.filter(chapter => chapter.novelId === 1).map(chapter => ({
    number: chapter.chapterNumber, downloaded: chapter.isDownloaded, contentBytes: chapter.contentBytes, mediaBytes: chapter.mediaBytes,
  }))).toEqual([
    { number: "1", downloaded: true, contentBytes: 0, mediaBytes: 0 },
    { number: "2", downloaded: false, contentBytes: 0, mediaBytes: 0 },
    { number: "3", downloaded: false, contentBytes: 0, mediaBytes: 0 },
  ]);
  storage.files.clear();
  const missing = await prepareBackupRestore(db, manifest());
  expect(missing.manifest.chapters.every(chapter => !chapter.isDownloaded)).toBe(true);
  expect(missing.cache.files).toEqual([]);
});

it("retains current byte counts only for the exact inspected directory and content type", async () => {
  vi.mocked(db.select).mockResolvedValue([{ pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/chapter/1",
    directory: `${first}/1`, storedContentType: "html", contentBytes: 28, mediaBytes: 3 }]);
  const plan = await prepareBackupRestore(db, manifest());
  expect(plan.manifest.chapters[0]).toMatchObject({ isDownloaded: true, contentBytes: 28, mediaBytes: 3 });
  expect(plan.manifest.chapters[1]).toMatchObject({ isDownloaded: false, contentBytes: 0, mediaBytes: 0 });
});

it("matches distinct local chapters by retained directories without mixing bookmarks", async () => {
  const snapshot = manifest();
  snapshot.novels[0] = { ...snapshot.novels[0]!, pluginId: "local", sourceNovelId: "local", path: "local", isLocal: true };
  snapshot.chapters = snapshot.chapters.map((chapter, index) => ({ ...chapter, name: "Old name", chapterNumber: String(index + 1), bookmark: index === 0, progress: index * 70 }));
  save(`${absent}/2/content.html`, "Second file");
  vi.mocked(db.select).mockResolvedValue([
    { pluginId: "local", novelId: "local", novelPath: "local", chapterPath: "/chapter/1", directory: `${absent}/1` },
    { pluginId: "local", novelId: "local", novelPath: "local", chapterPath: "/chapter/2", directory: `${absent}/2` },
  ]);
  const plan = await prepareBackupRestore(db, snapshot);
  expect(plan.manifest.chapters.slice(0, 2)).toMatchObject([
    { id: 1, isDownloaded: true, contentType: "pdf", bookmark: true, progress: 0 },
    { id: 2, isDownloaded: true, contentType: "html", bookmark: false, progress: 70 },
  ]);
});

it("restores local titles from the current disk catalog while retaining backup reading state", async () => {
  const snapshot = manifest();
  snapshot.novels[0] = { ...snapshot.novels[0]!, pluginId: "local", sourceNovelId: "local", path: "local", isLocal: true };
  snapshot.chapters = [{ ...snapshot.chapters[0]!, name: "Old local title" }];
  save(`${absent}/novel.json`, {
    identity: { pluginId: "local", novelId: "local", novelPath: "local" },
    novel: { name: "Local originals", isLocal: true },
    chapters: { "1": "New local title", "2": "Catalog without a body" },
  });
  const originalFiles = structuredClone(storage.files);
  const plan = await prepareBackupRestore(db, snapshot);
  const local = plan.manifest.chapters.filter(chapter => chapter.novelId === 1);
  expect(local.find(chapter => chapter.id === 1)).toMatchObject({
    name: "New local title", isDownloaded: true, contentType: "pdf", progress: 64, bookmark: true, unread: false, readAt: 70,
  });
  expect(local.find(chapter => chapter.chapterNumber === "2")).toMatchObject({
    path: "local-folder:2", name: "Catalog without a body", isDownloaded: false,
  });
  expect(storage.files).toEqual(originalFiles);
  expect(storage.mutations).toBe(0);
});

it("fails before native restore when originals cannot be inspected", async () => {
  const originalFiles = structuredClone(storage.files);
  storage.failPath = `${first}/novel.json`;
  await expect(prepareBackupRestore(db, manifest())).rejects.toThrow("Storage unavailable");
  expect(storage.files).toEqual(originalFiles);
  expect(storage.mutations).toBe(0);
});
