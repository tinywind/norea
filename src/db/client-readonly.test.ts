import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sqlPlugin = vi.hoisted(() => ({ get: vi.fn() }));
const libraryQueries = vi.hoisted(() => ({
  page: undefined as undefined | { queryFn: (context: { pageParam: null }) => Promise<unknown> },
  panels: [] as Array<{ queryFn: () => Promise<unknown> }>,
}));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: sqlPlugin }));
vi.mock("../lib/tauri-runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  useMemo: (factory: () => unknown) => factory(),
  useRef: () => ({ current: null }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
  useInfiniteQuery: (options: NonNullable<typeof libraryQueries.page>) => {
    libraryQueries.page = options;
    return { data: { pages: [] } };
  },
  useQuery: (options: (typeof libraryQueries.panels)[number]) => {
    libraryQueries.panels.push(options);
    return {};
  },
}));

let directory: string;
let writer: DatabaseSync;
let reader: DatabaseSync;
let release: () => void;
let writes: Promise<unknown>;

function connection(sqlite: DatabaseSync) {
  return {
    select: async (query: string, values: unknown[] = []) => sqlite.prepare(query).all(
      Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never,
    ),
    execute: async (query: string, values: unknown[] = []) => {
      const result = sqlite.prepare(query).run(Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  libraryQueries.panels.length = 0;
  mkdirSync(".tmp", { recursive: true });
  directory = mkdtempSync(".tmp/db-readonly-");
  const file = join(directory, "norea.db");
  writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  writer.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Saved work',1);
    INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,progress,bookmark) VALUES(1,1,'/chapter','Saved chapter',1,'1',0.5,1)`);
  reader = new DatabaseSync(file, { readOnly: true });
  sqlPlugin.get.mockImplementation((url: string) => {
    if (url === "sqlite:norea.db") return connection(writer);
    if (url === "sqlite:norea-readonly.db") return connection(reader);
    throw new Error(`Unexpected database: ${url}`);
  });
});

it.each([false, true])("filters the library and its panels before a sync write settles (rollback: %s)", async rollback => {
  writer.exec("INSERT INTO category(id,name,sort,is_system) VALUES(1,'Reading',0,0); INSERT INTO novel_category(novel_id,category_id) VALUES(1,1)");
  const { runDatabaseTransaction } = await import("./client");
  const { listLibraryNovelIds } = await import("./queries/novel");
  const { useLibraryQuery } = await import("../components/library/use-library-query");
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  writes = runDatabaseTransaction(async db => {
    await db.execute("UPDATE novel SET name='Refreshed work' WHERE id=1");
    started();
    await gate;
    if (rollback) throw new Error("Synchronization publication failed");
  });
  const settled = writes.catch(error => error);
  await active;
  let mutationSelectionFinished = false;
  const mutationSelection = listLibraryNovelIds({ search: "Saved", categoryId: 1 })
    .then(rows => { mutationSelectionFinished = true; return rows; });
  useLibraryQuery(true, { search: "Saved", categoryId: 1, unreadOnly: true }, "nameAsc");
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([
      Promise.all([
        libraryQueries.page!.queryFn({ pageParam: null }),
        ...libraryQueries.panels.map(query => query.queryFn()),
      ]),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Library filtering waited for synchronization publication")), 1_000); }),
    ]);
    expect(mutationSelectionFinished).toBe(false);
    expect(result).toMatchObject([
      { novels: [{ id: 1, name: "Saved work" }], hasMore: false },
      { totalNovels: 1 },
      { totalNovels: 1 },
      [{ pluginId: "source", totalNovels: 1 }],
      [{ id: 1, name: "Reading", novelCount: 1 }],
      { total: 1, uncategorized: 0 },
    ]);
  } finally { clearTimeout(timeout); release(); await settled; }
  expect(await mutationSelection).toEqual(rollback ? [1] : []);
  expect(await libraryQueries.page!.queryFn({ pageParam: null })).toMatchObject({
    novels: rollback ? [{ id: 1, name: "Saved work" }] : [],
  });
});

afterEach(async () => {
  release?.();
  await writes?.catch(() => undefined);
  reader.close();
  writer.close();
  rmSync(directory, { recursive: true });
});

it.each([false, true])("opens saved work details and chapters during queued metadata writes (rollback: %s)", async rollback => {
  const { runDatabaseTransaction } = await import("./client");
  const { getNovelById } = await import("./queries/novel");
  const { getChapterById, listChaptersByNovel } = await import("./queries/chapter");
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  writes = runDatabaseTransaction(async db => {
    await db.execute("UPDATE novel SET name='Refreshed work' WHERE id=1");
    await db.execute("UPDATE chapter SET name='Refreshed chapter' WHERE id=1");
    started();
    await gate;
    if (rollback) throw new Error("Metadata publication failed");
  });
  const result = writes.catch(error => error);
  await active;
  let queuedReadFinished = false;
  const queuedRead = Promise.all([getNovelById(1), listChaptersByNovel(1), getChapterById(1)])
    .then(value => { queuedReadFinished = true; return value; });
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    const [novel, chapters, chapter] = await Promise.race([
      Promise.all([getNovelById(1, "committed"), listChaptersByNovel(1, "committed"), getChapterById(1, "committed")]),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Work home waited for metadata publication")), 1000); }),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(queuedReadFinished).toBe(false);
    expect(chapter).toMatchObject({ name: "Saved chapter", progress: 0.5, bookmark: true });
    expect(novel).toMatchObject({ name: "Saved work", inLibrary: true });
    expect(chapters).toMatchObject([{ name: "Saved chapter", progress: 0.5, bookmark: true }]);
  } finally { clearTimeout(timeout); release(); await queuedRead; }
  await result;
  expect(await getNovelById(1, "committed")).toMatchObject({ name: rollback ? "Saved work" : "Refreshed work" });
  expect(await getChapterById(1, "committed")).toMatchObject({ name: rollback ? "Saved chapter" : "Refreshed chapter", progress: 0.5, bookmark: true });
  expect(await listChaptersByNovel(1, "committed")).toMatchObject([{ name: rollback ? "Saved chapter" : "Refreshed chapter", progress: 0.5, bookmark: true }]);
});
