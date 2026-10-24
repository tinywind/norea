import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sqlPlugin = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: sqlPlugin }));
vi.mock("../lib/tauri-runtime", () => ({ isTauriRuntime: () => false }));

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
  const { listChaptersByNovel } = await import("./queries/chapter");
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
  const queuedRead = Promise.all([getNovelById(1), listChaptersByNovel(1)])
    .then(value => { queuedReadFinished = true; return value; });
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    const [novel, chapters] = await Promise.race([
      Promise.all([getNovelById(1, "committed"), listChaptersByNovel(1, "committed")]),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Work home waited for metadata publication")), 1000); }),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(queuedReadFinished).toBe(false);
    expect(novel).toMatchObject({ name: "Saved work", inLibrary: true });
    expect(chapters).toMatchObject([{ name: "Saved chapter", progress: 0.5, bookmark: true }]);
  } finally { clearTimeout(timeout); release(); await queuedRead; }
  await result;
  expect(await getNovelById(1, "committed")).toMatchObject({ name: rollback ? "Saved work" : "Refreshed work" });
  expect(await listChaptersByNovel(1, "committed")).toMatchObject([{ name: rollback ? "Saved chapter" : "Refreshed chapter", progress: 0.5, bookmark: true }]);
});
