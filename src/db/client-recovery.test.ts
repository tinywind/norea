import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TestSqliteDatabase } from "../test/sql/types";

const storage = vi.hoisted(() => ({
  root: "old",
  files: new Map<string, Map<string, number[]>>(),
  gates: new Map<string, Promise<void>>(),
  release: [] as (() => void)[],
  calls: [] as string[],
  writes: 0,
  failRead: false,
  active: 0,
  transactions: 0,
  rawStatements: [] as string[],
}));
vi.mock("../lib/chapter-content/storage-platform", () => ({
  inspectChapterContentArtifacts: async (input: {
    preferredChapterDir: string;
    preferredContentFileName: string;
  }) => ({
    status: "present",
    contentFile: `${input.preferredChapterDir}/${input.preferredContentFileName}`,
    contentBytes: 1,
    mediaBytes: 0,
    mediaComplete: true,
  }),
}));
const covers = vi.hoisted(() => ({ changed: vi.fn(), invalidated: vi.fn() }));
const events = vi.hoisted(() => ({
  listeners: new Set<(event: { payload: unknown }) => void>(),
}));
const ipcBridge = vi.hoisted(() => ({
  handle: null as
    | null
    | ((
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<{ handled: true; result: unknown } | { handled: false }>),
}));
vi.mock("../lib/tauri-runtime", () => ({
  isTauriRuntime: () => true,
  isAndroidRuntime: () => false,
}));
vi.mock("../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));
vi.mock("../lib/novel-cover-storage", () => ({
  notifyNovelCoverChanged: covers.changed,
  invalidateAllNovelCoverSources: covers.invalidated,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, callback: (event: { payload: unknown }) => void) => {
    events.listeners.add(callback);
    return () => {
      events.listeners.delete(callback);
    };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (
    command: string,
    args: {
      root?: string;
      input?: { operation: string; path?: string; body?: number[] };
    } & Record<string, unknown> = {},
  ) => {
    if (command === "chapter_media_set_storage_root") {
      storage.root = args.root!;
      return args.root;
    }
    if (command === "plugin_vpn_sync_stored_profiles") {
      return null;
    }
    if (
      command === "db_source_renumber_list_journals" ||
      command === "db_novel_merge_list_storage_journals"
    ) {
      return [];
    }
    if (command === "db_repo_list") {
      return enqueueDb(async () =>
        (
          sqlite
            .prepare(
              "SELECT id, url, name, added_at AS addedAt, priority, enabled FROM repository ORDER BY priority, id",
            )
            .all() as Array<Record<string, unknown>>
        ).map((row) => ({
          ...row,
          enabled: Boolean(row.enabled),
        })),
      );
    }
    if (command === "db_novel_list_library_page") {
      return enqueueDb(async () => {
        const rows = sqlite
          .prepare(
            `SELECT n.id, n.plugin_id AS pluginId, n.source_novel_id AS sourceNovelId, n.path, n.name, n.cover, n.author,
                    n.in_library AS inLibrary, n.is_local AS isLocal,
                    COALESCE(s.total_chapters, 0) AS totalChapters,
                    COALESCE(s.chapters_downloaded, 0) AS chaptersDownloaded,
                    COALESCE(s.chapters_unread, 0) AS chaptersUnread,
                    COALESCE(s.reading_progress, 0) AS readingProgress,
                    n.last_read_at AS lastReadAt, n.updated_at AS lastUpdatedAt
             FROM novel n LEFT JOIN novel_stats s ON s.novel_id = n.id
             WHERE n.in_library = 1 ORDER BY n.name COLLATE NOCASE ASC, n.id ASC`,
          )
          .all() as Array<Record<string, unknown>>;
        return {
          hasMore: false,
          nextCursor: null,
          novels: rows.map((r) => ({
            ...r,
            inLibrary: Boolean(r.inLibrary),
            isLocal: Boolean(r.isLocal),
          })),
        };
      });
    }
    if (ipcBridge.handle) {
      const bridged = await ipcBridge.handle(command, args);
      if (bridged.handled) return bridged.result;
    }
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
      if (input.operation === "chapters")
        return { paths: [input.path!.replace("novel.json", "1/content.html")] };
      if (input.operation === "write") {
        storage.writes++;
        files.set(input.path!, input.body!);
      }
      if (input.operation === "remove") {
        storage.writes++;
        files.delete(input.path!);
      }
      return {};
    } finally {
      storage.active--;
    }
  },
}));

let sqlite: DatabaseSync;
let rawDb: TestSqliteDatabase;
let dbQueue: Promise<unknown>;
let client: typeof import("./client");
let state: typeof import("../store/storage-recovery").useStorageRecoveryStore;
const first = "contents/source/first/novel.json";
const second = "contents/source/second/novel.json";

function enqueueDb<T>(task: () => Promise<T>): Promise<T> {
  const next = dbQueue.then(task, task);
  dbQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function addWork(root: string, path: string, name: string) {
  const files = storage.files.get(root) ?? new Map<string, number[]>();
  files.set(path, [
    ...new TextEncoder().encode(
      JSON.stringify({
        identity: {
          pluginId: "source",
          novelId: path.split("/").at(-2),
          novelPath: `/${name}`,
        },
        novel: { name },
      }),
    ),
  ]);
  storage.files.set(root, files);
}

function block(key: string) {
  storage.gates.set(
    key,
    new Promise<void>((resolve) => {
      storage.release.push(resolve);
    }),
  );
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Foreground access waited for storage recovery")),
      1000,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timeout!);
  }
}

async function runHostTransaction<T>(
  run: (db: TestSqliteDatabase) => Promise<T>,
  remote = false,
): Promise<T> {
  const { withWorkMetadataRollback } = await import("../lib/work-metadata");
  const { flushWorkMetadata, restoreWorkMetadataDirectories } = await import(
    "../test/sql/work-metadata"
  );
  return enqueueDb(() =>
    withWorkMetadataRollback(async () => {
      sqlite.exec("BEGIN IMMEDIATE");
      storage.transactions++;
      try {
        if (remote) {
          sqlite.exec("UPDATE content_sync_origin SET remote = 1 WHERE id = 1");
        }
        const result = await run(rawDb);
        if (remote) {
          sqlite.exec("UPDATE content_sync_origin SET remote = 0 WHERE id = 1");
        }
        await flushWorkMetadata(rawDb);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        if (sqlite.isTransaction) {
          sqlite.exec("ROLLBACK");
        }
        await restoreWorkMetadataDirectories(rawDb, false);
        throw error;
      }
    }),
  );
}

async function installRecoveryModules() {
  events.listeners.clear();
  client = await import("./client");
  state = (await import("../store/storage-recovery")).useStorageRecoveryStore;
  const { createWorkMetadataIpcHandler } = await import(
    "../test/mock-work-metadata-ipc"
  );
  const { withWorkMetadataRollback } = await import("../lib/work-metadata");
  const { restoreWorkMetadataDirectories } = await import(
    "../test/sql/work-metadata"
  );
  ipcBridge.handle = createWorkMetadataIpcHandler({
    getDb: () => rawDb,
    runTransaction: runHostTransaction,
    runExclusive: (run) => enqueueDb(run),
    runRecoveryTransaction: async (_db, run) =>
      withWorkMetadataRollback(async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        storage.transactions++;
        try {
          const result = await run(rawDb);
          sqlite.exec("COMMIT");
          return result;
        } catch (error) {
          if (sqlite.isTransaction) {
            sqlite.exec("ROLLBACK");
          }
          await restoreWorkMetadataDirectories(rawDb, false);
          throw error;
        }
      }),
    emitRecoveryEvent: (payload) => {
      for (const listener of [...events.listeners]) {
        listener({ payload });
      }
    },
  }).handle;
}

beforeEach(async () => {
  vi.resetModules();
  dbQueue = Promise.resolve();
  covers.changed.mockClear();
  covers.invalidated.mockClear();
  storage.root = "old";
  storage.files.clear();
  storage.gates.clear();
  storage.release = [];
  storage.calls = [];
  storage.writes = 0;
  storage.failRead = false;
  storage.active = 0;
  storage.transactions = 0;
  storage.rawStatements = [];
  addWork("old", first, "First");
  sqlite = new DatabaseSync(":memory:");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/sql:\s*include_str!\("([^"]+)"\)/g)) {
    sqlite.exec(readFileSync(`src-tauri/src/${match[1]}`, "utf8"));
  }
  sqlite.exec(
    "INSERT INTO repository(id,url,name) VALUES(1,'https://example.test/plugins.json','Installed repository')",
  );
  rawDb = {
    path: "sqlite:norea.db",
    close: async () => false,
    select: async <T>(query: string, params: unknown[] = []) =>
      sqlite
        .prepare(query)
        .all(
          Object.fromEntries(
            params.map((value, index) => [`$${index + 1}`, value]),
          ) as never,
        ) as T,
    execute: async (query: string, params: unknown[] = []) => {
      storage.rawStatements.push(query);
      const result = sqlite
        .prepare(query)
        .run(
          Object.fromEntries(
            params.map((value, index) => [`$${index + 1}`, value]),
          ) as never,
        );
      return {
        rowsAffected: Number(result.changes),
        lastInsertId: Number(result.lastInsertRowid),
      };
    },
  };
  await installRecoveryModules();
});

afterEach(async () => {
  client.cancelWorkMetadataRecovery();
  storage.release.forEach((release) => release());
  await vi.waitFor(() => expect(storage.active).toBe(0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  sqlite.close();
});

it("recovers work metadata through host-owned per-work transactions", async () => {
  await client.initializeDatabaseSession();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  expect(storage.transactions).toBeGreaterThan(0);
  expect(
    storage.rawStatements.filter((query) =>
      /^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(query),
    ),
  ).toEqual([]);
  expect(await rawDb.select("SELECT name FROM novel")).toEqual([
    { name: "First" },
  ]);
});

it("keeps committed metadata after a later transaction fails with an older file on disk", async () => {
  await client.initializeDatabaseSession();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  const original = storage.files.get("old")!.get(first)!;
  await rawDb.execute(
    "UPDATE novel SET name='Latest title',summary='Latest summary' WHERE id=1",
  );
  storage.files.get("old")!.set(first, original);
  storage.calls = [];
  await expect(
    runHostTransaction(async (transaction) => {
      await transaction.execute(
        "UPDATE novel SET summary='Uncommitted' WHERE id=1",
      );
      throw new Error("Unrelated operation failed");
    }),
  ).rejects.toThrow("Unrelated operation failed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await rawDb.select("SELECT name,summary FROM novel")).toEqual([
    { name: "Latest title", summary: "Latest summary" },
  ]);
  expect(storage.calls).not.toContain("old:list:");
});

it("restores the work file when a transaction fails after publishing metadata", async () => {
  await client.initializeDatabaseSession();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  const original = storage.files.get("old")!.get(first)!;
  const { flushWorkMetadata } = await import("../test/sql/work-metadata");
  await expect(
    runHostTransaction(async (transaction) => {
      await transaction.execute(
        "UPDATE novel SET name='Uncommitted' WHERE id=1",
      );
      await flushWorkMetadata(transaction);
      throw new Error("Later operation failed");
    }),
  ).rejects.toThrow("Later operation failed");
  expect(await rawDb.select("SELECT name FROM novel")).toEqual([
    { name: "First" },
  ]);
  expect(storage.files.get("old")!.get(first)).toEqual(original);
});

it("opens the library and repository while local discovery is blocked and no server is configured", async () => {
  block("old:list:");
  await promptly(client.initializeDatabaseSession());
  await vi.waitFor(() => expect(storage.calls).toContain("old:list:"));
  const { listRepositories } = await import("./queries/repository");
  const { listLibraryNovelPage } = await import("./queries/novel");
  expect(await promptly(listRepositories())).toHaveLength(1);
  expect((await promptly(listLibraryNovelPage())).novels).toEqual([]);
  await promptly(
    enqueueDb(() =>
      rawDb.execute("UPDATE repository SET name=$1 WHERE id=1", ["Updated"]),
    ),
  );
  expect(sqlite.isTransaction).toBe(false);
  expect(storage.writes).toBe(0);
});

it("exposes recovered library works and progress while a later chapter scan is pending", async () => {
  addWork("old", second, "Second");
  block(`old:chapters:${second}`);
  const { subscribeWorkMetadataChanges } = await import("../lib/work-metadata");
  const sync = vi.fn(() => new Promise<void>(() => undefined));
  const unsubscribe = subscribeWorkMetadataChanges(sync);
  await promptly(client.initializeDatabaseSession());
  await vi.waitFor(() =>
    expect(storage.calls).toContain(`old:chapters:${second}`),
  );
  const { listLibraryNovelPage } = await import("./queries/novel");
  const page = await promptly(listLibraryNovelPage());
  expect(page.novels.map((work) => work.name)).toEqual(["First"]);
  expect(state.getState()).toMatchObject({
    status: "scanning",
    progress: {
      recoveredWorks: 1,
      recoveredChapters: 1,
      totalWorks: 2,
      currentWork: "Second",
    },
  });
  expect(sqlite.isTransaction).toBe(false);
  expect(storage.writes).toBe(0);
  expect(sync).toHaveBeenCalledOnce();
  expect(covers.changed).toHaveBeenCalledExactlyOnceWith(1, {
    pluginId: "source",
    path: "/First",
  });
  unsubscribe();
});

it("returns from folder selection before its file inspection finishes", async () => {
  addWork("selected", first, "Selected");
  block("selected:list:");
  const { setChapterMediaStorageRoot } = await import(
    "../lib/chapter-media-storage"
  );
  expect(await promptly(setChapterMediaStorageRoot("selected"))).toBe(
    "selected",
  );
  await vi.waitFor(() => expect(storage.calls).toContain("selected:list:"));
  expect(state.getState().status).toBe("scanning");
  const { listRepositories } = await import("./queries/repository");
  expect(await promptly(listRepositories())).toHaveLength(1);
});

it("discards a previous folder snapshot after selecting another root", async () => {
  block(`old:chapters:${first}`);
  await client.initializeDatabaseSession();
  await vi.waitFor(() =>
    expect(storage.calls).toContain(`old:chapters:${first}`),
  );
  addWork("new", second, "New");
  const { setChapterMediaStorageRoot } = await import(
    "../lib/chapter-media-storage"
  );
  await setChapterMediaStorageRoot("new");
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  storage.release.forEach((release) => release());
  await vi.waitFor(() => expect(storage.active).toBe(0));
  expect(sqlite.prepare("SELECT name FROM novel").all()).toEqual([
    { name: "New" },
  ]);
  expect(state.getState().progress?.recoveredWorks).toBe(1);
  expect(storage.writes).toBe(0);
});

it("reports recovery failure without poisoning the database or repository", async () => {
  storage.failRead = true;
  await promptly(client.initializeDatabaseSession());
  await vi.waitFor(() => expect(state.getState().status).toBe("error"));
  expect(state.getState().error).toContain("Storage is unavailable");
  const { listRepositories } = await import("./queries/repository");
  expect(await promptly(listRepositories())).toHaveLength(1);
  storage.failRead = false;
  client.startWorkMetadataRecovery(true);
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  expect(sqlite.prepare("SELECT name,in_library FROM novel").get()).toEqual({
    name: "First",
    in_library: 1,
  });
});

it("reopens an initialized database with pending metadata and publishes it without a folder scan", async () => {
  await client.initializeDatabaseSession();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  sqlite.exec(
    "UPDATE novel SET name='Pending title',summary='Pending summary' WHERE id=1",
  );
  vi.resetModules();
  await installRecoveryModules();
  storage.calls = [];
  await promptly(client.initializeDatabaseSession());
  expect(await rawDb.select("SELECT name,summary FROM novel")).toEqual([
    { name: "Pending title", summary: "Pending summary" },
  ]);
  await vi.waitFor(() =>
    expect(sqlite.prepare("SELECT * FROM work_metadata_dirty").all()).toEqual(
      [],
    ),
  );
  expect(
    JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(storage.files.get("old")!.get(first)!),
      ),
    ).novel,
  ).toMatchObject({ name: "Pending title", summary: "Pending summary" });
  expect(storage.calls).not.toContain("old:list:");
  expect(
    sqlite.prepare("SELECT * FROM work_metadata_cache_state").all(),
  ).toEqual([{ id: 1 }]);
});

it("retains pending metadata and usable database access when restart publication cannot read storage", async () => {
  await client.initializeDatabaseSession();
  await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
  const original = [...storage.files.get("old")!.get(first)!];
  sqlite.exec("UPDATE novel SET summary='Pending summary' WHERE id=1");
  vi.resetModules();
  await installRecoveryModules();
  storage.failRead = true;
  await promptly(client.initializeDatabaseSession());
  await vi.waitFor(() => expect(state.getState().status).toBe("error"));
  expect(await rawDb.select("SELECT summary FROM novel")).toEqual([
    { summary: "Pending summary" },
  ]);
  expect(
    sqlite.prepare("SELECT plugin_id,path FROM work_metadata_dirty").all(),
  ).toEqual([{ plugin_id: "source", path: "/First" }]);
  const { listRepositories } = await import("./queries/repository");
  expect(await promptly(listRepositories())).toHaveLength(1);
  expect(storage.files.get("old")!.get(first)).toEqual(original);
  expect(storage.writes).toBe(0);
});

it.each([true, undefined])(
  "recovers the current local work without moving or rewriting its files (isLocal: %s)",
  async (isLocal) => {
    const localPath = "contents/local/local/novel.json";
    storage.files.set(
      "old",
      new Map([
        [
          localPath,
          [
            ...new TextEncoder().encode(
              JSON.stringify({
                identity: {
                  pluginId: "local",
                  novelId: "local",
                  novelPath: "local",
                },
                novel: { name: "local", isLocal },
              }),
            ),
          ],
        ],
      ]),
    );
    const original = [...storage.files.get("old")!.get(localPath)!];
    await client.initializeDatabaseSession();
    await vi.waitFor(() => expect(state.getState().status).toBe("complete"));
    expect(
      sqlite
        .prepare("SELECT plugin_id,path,name,in_library,is_local FROM novel")
        .all(),
    ).toEqual([
      {
        plugin_id: "local",
        path: "local",
        name: "local",
        in_library: 1,
        is_local: 1,
      },
    ]);
    expect(storage.files.get("old")!.get(localPath)).toEqual(original);
    expect(storage.writes).toBe(0);
  },
);
