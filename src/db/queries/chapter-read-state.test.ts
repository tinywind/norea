import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import {
  restoreChapterReadStates,
  setChaptersReadState,
  setNovelsReadState,
  setRelativeChaptersReadState,
  updateChapterProgress,
} from "./chapter";

let sqlite: DatabaseSync;
const bind = (params: unknown[]) =>
  Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name) VALUES (1,'source','/one','One'), (2,'source','/two','Two');
    INSERT INTO chapter(id,novel_id,path,name,position,unread,progress) VALUES
    (1,1,'/1','Read',1,0,100), (2,1,'/2','Unread',2,1,0), (3,1,'/3','Partly read',3,1,40),
    (4,1,'/4','Anchor',4,1,0), (5,1,'/5','Read later',5,0,100), (6,2,'/6','Other work',1,1,0)`);
  const db = {
    select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(bind(params)),
    execute: async (sql: string, params: unknown[] = []) =>
      ({ rowsAffected: Number(sqlite.prepare(sql).run(bind(params)).changes) }),
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async (run) => run(db as never));
});
afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

const readStates = () =>
  sqlite.prepare("SELECT id, unread, progress FROM chapter ORDER BY id").all()
    .map((row) => ({ id: row.id, unread: row.unread === 1, progress: row.progress }));

it("captures each selected chapter's state before marking and restores it exactly", async () => {
  const before = readStates();
  const change = await setChaptersReadState([1, 2, 3], false);
  expect([...change.previous].sort((left, right) => left.id - right.id)).toEqual([
    { id: 1, unread: false, progress: 100 },
    { id: 2, unread: true, progress: 0 },
    { id: 3, unread: true, progress: 40 },
  ]);
  expect(readStates().slice(0, 3).every((row) => !row.unread && row.progress === 100)).toBe(true);

  await expect(restoreChapterReadStates(change.previous)).resolves.toMatchObject({ rowsAffected: 3 });
  expect(readStates()).toEqual(before);
});

it("captures only the chapters a relative mark changes, and restores them", async () => {
  const before = readStates();
  const change = await setRelativeChaptersReadState(4, "before", false);
  expect(change.rowsAffected).toBe(2);
  expect(change.previous.map((row) => row.id).sort()).toEqual([2, 3]);

  await restoreChapterReadStates(change.previous);
  expect(readStates()).toEqual(before);

  const unmark = await setRelativeChaptersReadState(4, "after", true);
  expect(unmark.previous).toEqual([{ id: 5, unread: false, progress: 100 }]);
  await restoreChapterReadStates(unmark.previous);
  expect(readStates()).toEqual(before);
});

it("restores many chapters with different progress in bounded statements", async () => {
  const insert = sqlite.prepare(
    "INSERT INTO chapter(id,novel_id,path,name,position,unread,progress) VALUES (?,2,?,'Bulk',?,?,?)",
  );
  const ids = Array.from({ length: 1_200 }, (_, index) => 100 + index);
  for (const [index, id] of ids.entries()) {
    insert.run(id, `/bulk/${id}`, index + 2, index % 3 === 0 ? 0 : 1, index % 3 === 0 ? 100 : index % 7);
  }
  const before = readStates();
  const change = await setChaptersReadState(ids, true);
  expect(change.previous).toHaveLength(ids.length);

  const restored = await restoreChapterReadStates(change.previous);
  expect(restored.rowsAffected).toBe(ids.length);
  expect(readStates()).toEqual(before);
});

it("restores nothing for an empty capture", async () => {
  await expect(restoreChapterReadStates([])).resolves.toEqual({ rowsAffected: 0, chunks: 0 });
  expect(runDatabaseTransaction).not.toHaveBeenCalled();
});

it.each([true, false])(
  "keeps a finished chapter finished when the reader saves a lower position (history %s)",
  async (recordHistory) => {
    await updateChapterProgress(1, 49, { recordHistory });
    await updateChapterProgress(3, 70, { recordHistory });
    const rows = readStates();
    expect(rows[0]).toEqual({ id: 1, unread: false, progress: 100 });
    expect(rows[2]).toEqual({ id: 3, unread: true, progress: 70 });
  },
);

it("still lets an explicit unread mark clear a finished chapter", async () => {
  await setChaptersReadState([1], true);
  expect(readStates()[0]).toEqual({ id: 1, unread: true, progress: 0 });
  await updateChapterProgress(1, 30);
  expect(readStates()[0]).toEqual({ id: 1, unread: true, progress: 30 });
});

it("marks whole novels, captures only the chapters it changed, and restores them", async () => {
  const before = readStates();
  const change = await setNovelsReadState([1, 2], false);
  expect(change.rowsAffected).toBe(4);
  expect(change.previous.map((row) => row.id).sort()).toEqual([2, 3, 4, 6]);
  expect(readStates().every((row) => !row.unread && row.progress === 100)).toBe(true);

  await restoreChapterReadStates(change.previous);
  expect(readStates()).toEqual(before);

  const unmark = await setNovelsReadState([2], true);
  expect(unmark.rowsAffected).toBe(0);
  const unmarkFirst = await setNovelsReadState([1], true);
  expect(unmarkFirst.previous.map((row) => row.id).sort()).toEqual([1, 3, 5]);
  expect(readStates().find((row) => row.id === 6)).toEqual({ id: 6, unread: true, progress: 0 });
});
