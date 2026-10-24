import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  root: "old", files: new Map<string, Map<string, number[]>>(),
  gates: new Map<string, Promise<void>>(), release: [] as (() => void)[],
  calls: [] as string[], writes: 0, failRead: false, active: 0,
}));
vi.mock("../lib/chapter-content/storage-platform", () => ({ inspectChapterContentArtifacts: async (input: { preferredChapterDir: string; preferredContentFileName: string }) => ({
  status: "present", contentFile: `${input.preferredChapterDir}/${input.preferredContentFileName}`, contentBytes: 1, mediaBytes: 0, mediaComplete: true,
}) }));
const sql = vi.hoisted(() => ({ get: vi.fn() }));
const covers = vi.hoisted(() => ({ changed: vi.fn(), invalidated: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: sql }));
vi.mock("../lib/tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("../lib/observability", () => ({ startPerformanceObservation: () => () => undefined, recordPerformanceObservation: () => undefined }));
vi.mock("../lib/novel-cover-storage", () => ({ notifyNovelCoverChanged: covers.changed, invalidateAllNovelCoverSources: covers.invalidated }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: { root?: string; input?: { operation: string; path?: string; body?: number[] } }) => {
  if (command === "chapter_media_set_storage_root") { storage.root = args.root!; return args.root; }
  const input = args.input!;
  const root = storage.root;
  const files = storage.files.get(root)!;
  const key = `${root}:${input.operation}:${input.path ?? ""}`;
  storage.calls.push(key);
  storage.active++;
  try {
    await storage.gates.get(key);
    if (input.operation === "list") return { paths: [...files.keys()] };
    if (input.operation === "read") {
      if (storage.failRead) throw new Error("Storage is unavailable");
      return { body: files.get(input.path!) ?? null };
    }
    if (input.operation === "chapters") return { paths: [input.path!.replace("novel.json", "1/content.html")] };
    if (input.operation === "write") { storage.writes++; files.set(input.path!, input.body!); }
    if (input.operation === "remove") { storage.writes++; files.delete(input.path!); }
    return {};
  } finally { storage.active--; }
} }));

let sqlite: DatabaseSync;
let client: typeof import("./client");
let state: typeof import("../store/storage-recovery").useStorageRecoveryStore;
const first = "contents/source/first/novel.json";
const second = "contents/source/second/novel.json";

function addWork(root: string, path: string, name: string) {
  const files = storage.files.get(root) ?? new Map<string, number[]>();
  files.set(path, [...new TextEncoder().encode(JSON.stringify({
    identity: { pluginId: "source", novelId: path.split("/").at(-2), novelPath: `/${name}` }, novel: { name },
  }))]);
  storage.files.set(root, files);
}

function block(key: string) {
  storage.gates.set(key, new Promise<void>(resolve => { storage.release.push(resolve); }));
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Foreground access waited for storage recovery")), 1000);
  });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timeout!); }
}

beforeEach(async () => {
  vi.resetModules();
  covers.changed.mockClear(); covers.invalidated.mockClear();
  storage.root = "old"; storage.files.clear(); storage.gates.clear(); storage.release = [];
  storage.calls = []; storage.writes = 0; storage.failRead = false; storage.active = 0;
  addWork("old", first, "First");
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec("INSERT INTO repository(id,url,name) VALUES(1,'https://example.test/plugins.json','Installed repository')");
  sql.get.mockReturnValue({
    path: "sqlite:norea.db",
    select: async (query: string, params: unknown[] = []) => sqlite.prepare(query).all(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never),
    execute: async (query: string, params: unknown[] = []) => {
      const result = sqlite.prepare(query).run(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  });
  client = await import("./client");
  state = (await import("../store/storage-recovery")).useStorageRecoveryStore;
});

afterEach(async () => {
  client.cancelWorkMetadataRecovery();
  storage.release.forEach(release => release());
  await vi.waitFor(() => expect(storage.active).toBe(0));
  await new Promise(resolve => setTimeout(resolve, 0));
  sqlite.close();
});

it("keeps committed metadata after a later transaction fails with an older file on disk", async () => {
  const db = await client.getDb();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  const original = storage.files.get("old")!.get(first)!;
  await db.execute("UPDATE novel SET name='Latest title',summary='Latest summary' WHERE id=1");
  storage.files.get("old")!.set(first, original);
  storage.calls = [];
  await expect(client.runDatabaseTransaction(async transaction => {
    await transaction.execute("UPDATE novel SET summary='Uncommitted' WHERE id=1");
    throw new Error("Unrelated operation failed");
  })).rejects.toThrow("Unrelated operation failed");
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(await db.select("SELECT name,summary FROM novel")).toEqual([{ name: "Latest title", summary: "Latest summary" }]);
  expect(storage.calls).not.toContain("old:list:");
});

it("restores the work file when a transaction fails after publishing metadata", async () => {
  const db = await client.getDb();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  const original = storage.files.get("old")!.get(first)!;
  const { flushWorkMetadata } = await import("./work-metadata");
  await expect(client.runDatabaseTransaction(async transaction => {
    await transaction.execute("UPDATE novel SET name='Uncommitted' WHERE id=1");
    await flushWorkMetadata(transaction);
    throw new Error("Later operation failed");
  })).rejects.toThrow("Later operation failed");
  expect(await db.select("SELECT name FROM novel")).toEqual([{ name: "First" }]);
  expect(storage.files.get("old")!.get(first)).toEqual(original);
});

it("opens the library and repository while local discovery is blocked and no server is configured", async () => {
  block("old:list:");
  const db = await promptly(client.getDb());
  await vi.waitFor(() => expect(storage.calls).toContain("old:list:"));
  const { listRepositories } = await import("./queries/repository");
  const { listLibraryNovelPage } = await import("./queries/novel");
  expect(await promptly(listRepositories())).toHaveLength(1);
  expect((await promptly(listLibraryNovelPage())).novels).toEqual([]);
  await promptly(db.execute("UPDATE repository SET name=$1 WHERE id=1", ["Updated"]));
  expect(sqlite.isTransaction).toBe(false);
  expect(storage.writes).toBe(0);
});

it("exposes recovered library works and progress while a later chapter scan is pending", async () => {
  addWork("old", second, "Second");
  block(`old:chapters:${second}`);
  const { subscribeWorkMetadataChanges } = await import("../lib/work-metadata");
  const sync = vi.fn(() => new Promise<void>(() => undefined));
  const unsubscribe = subscribeWorkMetadataChanges(sync);
  await promptly(client.getDb());
  await vi.waitFor(() => expect(storage.calls).toContain(`old:chapters:${second}`));
  const { listLibraryNovelPage } = await import("./queries/novel");
  const page = await promptly(listLibraryNovelPage());
  expect(page.novels.map(work => work.name)).toEqual(["First"]);
  expect(state.getState()).toMatchObject({ status: "scanning", progress: { recoveredWorks: 1, recoveredChapters: 1, totalWorks: 2, currentWork: "Second" } });
  expect(sqlite.isTransaction).toBe(false);
  expect(storage.writes).toBe(0);
  expect(sync).toHaveBeenCalledOnce();
  expect(covers.changed).toHaveBeenCalledExactlyOnceWith(1, { pluginId: "source", path: "/First" });
  unsubscribe();
});

it("returns from folder selection before its file inspection finishes", async () => {
  addWork("selected", first, "Selected");
  block("selected:list:");
  const { setChapterMediaStorageRoot } = await import("../lib/chapter-media-storage");
  expect(await promptly(setChapterMediaStorageRoot("selected"))).toBe("selected");
  await vi.waitFor(() => expect(storage.calls).toContain("selected:list:"));
  expect(state.getState().status).toBe("scanning");
  expect(await promptly((await client.getDb()).select("SELECT id FROM repository"))).toHaveLength(1);
});

it("discards a previous folder snapshot after selecting another root", async () => {
  block(`old:chapters:${first}`);
  await client.getDb();
  await vi.waitFor(() => expect(storage.calls).toContain(`old:chapters:${first}`));
  addWork("new", second, "New");
  const { setChapterMediaStorageRoot } = await import("../lib/chapter-media-storage");
  await setChapterMediaStorageRoot("new");
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  storage.release.forEach(release => release());
  await vi.waitFor(() => expect(storage.active).toBe(0));
  expect(sqlite.prepare("SELECT name FROM novel").all()).toEqual([{ name: "New" }]);
  expect(state.getState().progress?.recoveredWorks).toBe(1);
  expect(storage.writes).toBe(0);
});

it("reports recovery failure without poisoning the database or repository", async () => {
  storage.failRead = true;
  const db = await promptly(client.getDb());
  await vi.waitFor(() => expect(state.getState().status).toBe("error"));
  expect(state.getState().error).toContain("Storage is unavailable");
  expect(await promptly(db.select("SELECT id FROM repository"))).toHaveLength(1);
  storage.failRead = false;
  client.startWorkMetadataRecovery(true);
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  expect(sqlite.prepare("SELECT name,in_library FROM novel").get()).toEqual({ name: "First", in_library: 1 });
});

it("reopens an initialized database with pending metadata and publishes it without a folder scan", async () => {
  await client.getDb();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  sqlite.exec("UPDATE novel SET name='Pending title',summary='Pending summary' WHERE id=1");
  vi.resetModules();
  client = await import("./client");
  state = (await import("../store/storage-recovery")).useStorageRecoveryStore;
  storage.calls = [];
  const db = await promptly(client.getDb());
  expect(await db.select("SELECT name,summary FROM novel")).toEqual([{ name: "Pending title", summary: "Pending summary" }]);
  await vi.waitFor(() => expect(sqlite.prepare("SELECT * FROM work_metadata_dirty").all()).toEqual([]));
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get("old")!.get(first)!))).novel).toMatchObject({ name: "Pending title", summary: "Pending summary" });
  expect(storage.calls).not.toContain("old:list:");
  expect(sqlite.prepare("SELECT * FROM work_metadata_cache_state").all()).toEqual([{ id: 1 }]);
});

it("retains pending metadata and usable database access when restart publication cannot read storage", async () => {
  await client.getDb();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  const original = [...storage.files.get("old")!.get(first)!];
  sqlite.exec("UPDATE novel SET summary='Pending summary' WHERE id=1");
  vi.resetModules();
  client = await import("./client");
  state = (await import("../store/storage-recovery")).useStorageRecoveryStore;
  storage.failRead = true;
  const db = await promptly(client.getDb());
  await vi.waitFor(() => expect(state.getState().status).toBe("error"));
  expect(await db.select("SELECT summary FROM novel")).toEqual([{ summary: "Pending summary" }]);
  expect(sqlite.prepare("SELECT plugin_id,path FROM work_metadata_dirty").all()).toEqual([{ plugin_id: "source", path: "/First" }]);
  expect(await promptly(db.select("SELECT id FROM repository"))).toHaveLength(1);
  expect(storage.files.get("old")!.get(first)).toEqual(original);
  expect(storage.writes).toBe(0);
});

it.each([true, undefined])("recovers the current local work without moving or rewriting its files (isLocal: %s)", async (isLocal) => {
  const localPath = "contents/local/local/novel.json";
  storage.files.set("old", new Map([[localPath, [...new TextEncoder().encode(JSON.stringify({
    identity: { pluginId: "local", novelId: "local", novelPath: "local" }, novel: { name: "local", isLocal },
  }))]]]));
  const original = [...storage.files.get("old")!.get(localPath)!];
  await client.getDb();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  expect(sqlite.prepare("SELECT plugin_id,path,name,in_library,is_local FROM novel").all()).toEqual([
    { plugin_id: "local", path: "local", name: "local", in_library: 1, is_local: 1 },
  ]);
  expect(storage.files.get("old")!.get(localPath)).toEqual(original);
  expect(storage.writes).toBe(0);
});
