import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TestSqliteDatabase } from "../test/sql/types";

const invokeMock = vi.hoisted(() => vi.fn());
const libraryQueries = vi.hoisted(() => ({
  page: undefined as undefined | { queryFn: (context: { pageParam: null }) => Promise<unknown> },
  panels: [] as Array<{ queryFn: () => Promise<unknown> }>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../lib/tauri-runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  useMemo: (factory: () => unknown) => factory(),
  useRef: () => ({ current: null }),
}));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: <T>(previous: T) => previous,
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
let writerQueue: Promise<unknown>;
let release: () => void;
let writes: Promise<unknown>;

function connection(sqlite: DatabaseSync): TestSqliteDatabase {
  return {
    path: "sqlite:norea.db",
    close: async () => false,
    select: async <T>(query: string, values: unknown[] = []) =>
      sqlite.prepare(query).all(
        Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never,
      ) as T,
    execute: async (query: string, values: unknown[] = []) => {
      const result = sqlite
        .prepare(query)
        .run(Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  };
}

function enqueueWriter<T>(task: () => Promise<T>): Promise<T> {
  const next = writerQueue.then(task, task);
  writerQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function getQueuedDb(): Promise<TestSqliteDatabase> {
  return enqueueWriter(async () => connection(writer));
}

function getCommittedDb(): Promise<TestSqliteDatabase> {
  return Promise.resolve(connection(reader));
}

function runWriterTransaction<T>(
  run: (db: TestSqliteDatabase) => Promise<T>,
  remote = false,
): Promise<T> {
  return enqueueWriter(async () => {
    const db = connection(writer);
    writer.exec("BEGIN IMMEDIATE");
    try {
      if (remote) {
        writer.exec("UPDATE content_sync_origin SET remote = 1 WHERE id = 1");
      }
      const value = await run(db);
      if (remote) {
        writer.exec("UPDATE content_sync_origin SET remote = 0 WHERE id = 1");
      }
      writer.exec("COMMIT");
      return value;
    } catch (error) {
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      throw error;
    }
  });
}

beforeEach(() => {
  vi.resetModules();
  libraryQueries.panels.length = 0;
  writerQueue = Promise.resolve();
  mkdirSync(".tmp", { recursive: true });
  directory = mkdtempSync(".tmp/db-readonly-");
  const file = join(directory, "norea.db");
  writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  writer.exec(readFileSync("src-tauri/src/migrations/0010_novel_chapter_composition.sql", "utf8"));
  writer.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Saved work',1);
    INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,progress,bookmark) VALUES(1,1,'/chapter','Saved chapter',1,'1',0.5,1)`);
  reader = new DatabaseSync(file, { readOnly: true });
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const { createChapterIpcHandler } = await import("../test/mock-chapter-ipc");
    const chapterIpc = createChapterIpcHandler({
      getDb: getQueuedDb,
      getReadOnlyDb: getCommittedDb,
      runTransaction: runWriterTransaction,
    });
    const chapterHandled = await chapterIpc.handle(command, args);
    if (chapterHandled.handled) return chapterHandled.result;
    const db = await (args.mode === "committed" ? getCommittedDb() : getQueuedDb());
    if (command === "db_category_list") {
      const rows = await db.select<Array<{ id: number; name: string; sort: number; isSystem: number; novelCount: number }>>(
        `SELECT c.id, c.name, c.sort, c.is_system AS isSystem, COUNT(DISTINCT n.id) AS novelCount
         FROM category c
         LEFT JOIN novel_category nc ON nc.category_id = c.id
         LEFT JOIN novel n ON n.id = nc.novel_id AND n.in_library = 1
         GROUP BY c.id, c.name, c.sort, c.is_system
         ORDER BY c.sort, c.name`,
      );
      return rows.map(row => ({ ...row, isSystem: !!row.isSystem, novelCount: Number(row.novelCount) }));
    }
    if (command === "db_category_get_library_counts") {
      const totalRows = await db.select<{ count: number }[]>("SELECT COUNT(*) AS count FROM novel WHERE in_library = 1");
      const uncategorizedRows = await db.select<{ count: number }[]>(
        `SELECT COUNT(*) AS count FROM novel n
         WHERE n.in_library = 1 AND NOT EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id)`,
      );
      return { total: totalRows[0]?.count ?? 0, uncategorized: uncategorizedRows[0]?.count ?? 0 };
    }
    const buildFilter = (filter: {
      search?: string;
      categoryId?: number | null;
      unreadOnly?: boolean;
    } = {}) => {
      const params: unknown[] = [];
      const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
      const conditions = ["n.in_library = 1"];
      if (filter.search?.trim()) conditions.push(`n.name LIKE '%' || ${add(filter.search.trim())} || '%' COLLATE NOCASE`);
      if (filter.categoryId === -1) {
        conditions.push("NOT EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id)");
      } else if (filter.categoryId != null) {
        conditions.push(`EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id AND nc.category_id = ${add(filter.categoryId)})`);
      }
      if (filter.unreadOnly) conditions.push("COALESCE(s.chapters_unread, 0) > 0");
      return { conditions, params };
    };
    if (command === "db_novel_list_library_ids") {
      const { conditions, params } = buildFilter(args.filter as never);
      const rows = await db.select<Array<{ id: number }>>(
        `SELECT n.id FROM novel n LEFT JOIN novel_stats s ON s.novel_id = n.id WHERE ${conditions.join(" AND ")} ORDER BY n.id`,
        params,
      );
      return rows.map(row => row.id);
    }
    if (command === "db_novel_list_library_page") {
      const { conditions, params } = buildFilter(args.filter as never);
      const rows = await db.select<Array<Record<string, unknown>>>(
        `SELECT n.id, n.plugin_id AS pluginId, n.source_novel_id AS sourceNovelId, n.path, n.name, n.cover, n.author,
                n.in_library AS inLibrary, n.is_local AS isLocal,
                COALESCE(s.total_chapters, 0) AS totalChapters,
                COALESCE(s.chapters_downloaded, 0) AS chaptersDownloaded,
                COALESCE(s.chapters_unread, 0) AS chaptersUnread,
                COALESCE(s.reading_progress, 0) AS readingProgress,
                n.last_read_at AS lastReadAt, n.updated_at AS lastUpdatedAt
         FROM novel n LEFT JOIN novel_stats s ON s.novel_id = n.id
         WHERE ${conditions.join(" AND ")} ORDER BY n.name COLLATE NOCASE ASC, n.id ASC`,
        params,
      );
      return {
        hasMore: false,
        nextCursor: null,
        novels: rows.map(r => ({ ...r, inLibrary: Boolean(r.inLibrary), isLocal: Boolean(r.isLocal) })),
      };
    }
    if (command === "db_novel_get_library_summary") {
      const { conditions, params } = buildFilter(args.filter as never);
      const [row] = await db.select<Array<{ totalNovels: number }>>(
        `SELECT COUNT(*) AS totalNovels FROM novel n LEFT JOIN novel_stats s ON s.novel_id = n.id WHERE ${conditions.join(" AND ")}`,
        params,
      );
      return {
        completeNovels: 0,
        downloadedChapters: 0,
        downloadedNovels: 0,
        lastUpdatedAt: null,
        localNovels: 0,
        repairNeededNovels: 0,
        totalChapters: 0,
        totalNovels: row?.totalNovels ?? 0,
        unreadChapters: 0,
        unreadNovels: 0,
      };
    }
    if (command === "db_novel_list_library_source_filters") {
      const { conditions, params } = buildFilter(args.filter as never);
      return db.select<Array<{ pluginId: string; pluginName: string | null; totalNovels: number }>>(
        `SELECT n.plugin_id AS pluginId, ip.name AS pluginName, COUNT(*) AS totalNovels
         FROM novel n LEFT JOIN novel_stats s ON s.novel_id = n.id LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
         WHERE ${conditions.join(" AND ")} GROUP BY n.plugin_id, ip.name`,
        params,
      );
    }
    if (command === "db_novel_list_library_status_filters") {
      const { conditions, params } = buildFilter(args.filter as never);
      return db.select<Array<{ status: string; totalNovels: number }>>(
        `SELECT COALESCE(NULLIF(trim(n.status), ''), 'Unknown') AS status, COUNT(*) AS totalNovels
         FROM novel n LEFT JOIN novel_stats s ON s.novel_id = n.id
         WHERE ${conditions.join(" AND ")} GROUP BY COALESCE(NULLIF(trim(n.status), ''), 'Unknown')`,
        params,
      );
    }
    if (command === "db_novel_list_library_tag_filters") {
      return [];
    }
    if (command === "db_novel_get_by_id") {
      const [row] = await db.select<Array<Record<string, unknown>>>(
        `SELECT n.id, n.source_novel_id AS sourceNovelId, n.plugin_id AS pluginId, ip.name AS pluginName,
                n.path, n.name, n.cover, n.summary, n.author, n.artist, n.status, n.genres, n.rating,
                n.in_library AS inLibrary, n.is_local AS isLocal, n.created_at AS createdAt,
                n.updated_at AS updatedAt, n.library_added_at AS libraryAddedAt, n.last_read_at AS lastReadAt
         FROM novel n LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id WHERE n.id = $1`,
        [args.id],
      );
      return row ? { ...row, inLibrary: Boolean(row.inLibrary), isLocal: Boolean(row.isLocal) } : null;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

it.each([false, true])("filters the library and its panels before a sync write settles (rollback: %s)", async rollback => {
  writer.exec("INSERT INTO category(id,name,sort,is_system) VALUES(1,'Reading',0,0); INSERT INTO novel_category(novel_id,category_id) VALUES(1,1)");
  const { listLibraryNovelIds } = await import("./queries/novel");
  const { useLibraryQuery } = await import("../components/library/use-library-query");
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  writes = runWriterTransaction(async db => {
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
      [{ status: "Unknown", totalNovels: 1 }],
      [],
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
  const { getNovelById } = await import("./queries/novel");
  const { getChapterById, listChaptersByNovel } = await import("./queries/chapter");
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  writes = runWriterTransaction(async db => {
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
  expect(await listChaptersByNovel(1, "committed")).toMatchObject([{ name: "Saved chapter" === (rollback ? "Saved chapter" : "Refreshed chapter") ? "Saved chapter" : "Refreshed chapter", progress: 0.5, bookmark: true }]);
});

it("lists Updates, its badge and History while a check holds the database queue", async () => {
  writer.exec(readFileSync("src-tauri/src/migrations/0007_novel_freshness.sql", "utf8"));
  writer.exec(`UPDATE chapter SET read_at=100 WHERE id=1;
    INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,unread,found_at,found_by_check) VALUES(2,1,'/new','New chapter',2,'2',1,200,1)`);
  const { countNewLibraryChaptersSince, listLibraryUpdatesPage } = await import("./queries/chapter");
  const { listReadingHistoryPage } = await import("./queries/history-search");
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  writes = runWriterTransaction(async db => {
    await db.execute("INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,unread,found_at,found_by_check) VALUES(3,1,'/newer','Newer chapter',3,'3',1,300,1)");
    started();
    await gate;
  });
  await active;
  let queuedReadFinished = false;
  const queuedRead = listLibraryUpdatesPage(10).then(page => { queuedReadFinished = true; return page; });
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    const [updates, badge, history] = await Promise.race([
      Promise.all([
        listLibraryUpdatesPage(10, null, "new", "committed"),
        countNewLibraryChaptersSince(0, "committed"),
        listReadingHistoryPage({ readMode: "committed" }),
      ]),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Updates or History waited for the check")), 1000); }),
    ]);
    expect(queuedReadFinished).toBe(false);
    expect(updates.updates.map(row => row.chapterId)).toEqual([2]);
    expect(badge).toBe(1);
    expect(history.entries.map(entry => entry.chapterId)).toEqual([1]);
  } finally { clearTimeout(timeout); release(); }
  await writes;
  expect((await queuedRead).updates.map(row => row.chapterId)).toEqual([3, 2]);
  expect((await listLibraryUpdatesPage(10, null, "new", "committed")).updates.map(row => row.chapterId)).toEqual([3, 2]);
});
