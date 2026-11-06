import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import {
  clearChapterDownloadFailures,
  getChapterDownloadFailure,
  listChapterDownloadFailures,
  recordChapterDownloadFailure,
  type ChapterDownloadFailureInput,
} from "./chapter-download-failure";

let sqlite: DatabaseSync;

const params = (values: unknown[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never;
const raw = {
  select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql).all(params(values)),
  execute: async (sql: string, values: unknown[] = []) =>
    ({ rowsAffected: Number(sqlite.prepare(sql).run(params(values)).changes), lastInsertId: 0 }),
};

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/include_str!\("([^"]+)"\)/g)) {
    sqlite.exec(readFileSync(`src-tauri/src/${match[1]}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/work','Work');
    INSERT INTO chapter(id,novel_id,path,name,position) VALUES(1,1,'/1','One',1),(2,1,'/2','Two',2)`);
  vi.mocked(getDb).mockResolvedValue(raw as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async (run) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = await run(raw as never); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
});

afterEach(() => { sqlite.close(); });

function failure(chapterId: number, extra: Partial<ChapterDownloadFailureInput> = {}): ChapterDownloadFailureInput {
  return {
    chapterId, pluginId: "source", failureClass: "transient", messageSummary: "Timed out",
    jobJson: JSON.stringify({ id: chapterId }), now: 1_000,
    retryDelayMs: (attempts) => attempts <= 3 ? attempts * 10 : null, ...extra,
  };
}

it("counts attempts from the persisted row and stops scheduling after the budget", async () => {
  const recorded = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    recorded.push(await recordChapterDownloadFailure(failure(1, { now: 1_000 + attempt })));
  }
  expect(recorded.map((row) => [row?.attempts, row?.nextRetryAt])).toEqual([[1, 1_010], [2, 1_021], [3, 1_032], [4, null]]);
  expect(await listChapterDownloadFailures()).toEqual([expect.objectContaining({
    chapterId: 1, pluginId: "source", failureClass: "transient", attempts: 4, nextRetryAt: null, updatedAt: 1_003,
  })]);
});

it("reads only the requested chapter with its persisted retry admission", async () => {
  await recordChapterDownloadFailure(failure(1, { retryDelayMs: () => null }));
  await recordChapterDownloadFailure(failure(2, { now: 2_000, retryDelayMs: () => 500 }));
  expect(await getChapterDownloadFailure(2)).toMatchObject({ chapterId: 2, attempts: 1, nextRetryAt: 2_500 });
  expect(await getChapterDownloadFailure(1)).toMatchObject({ chapterId: 1, attempts: 1, nextRetryAt: null });
  expect(await getChapterDownloadFailure(99)).toBeUndefined();
});

it("keeps the latest class, summary and challenge host", async () => {
  await recordChapterDownloadFailure(failure(2));
  await recordChapterDownloadFailure(failure(2, {
    failureClass: "challenge", messageSummary: "Verify", challengeUrl: "https://cdn.example/", retryDelayMs: () => null,
  }));
  expect(await listChapterDownloadFailures()).toEqual([expect.objectContaining({
    chapterId: 2, failureClass: "challenge", messageSummary: "Verify", challengeUrl: "https://cdn.example/", attempts: 2, nextRetryAt: null,
  })]);
});

it("does not record a failure for a deleted chapter and clears with the chapter", async () => {
  expect(await recordChapterDownloadFailure(failure(99))).toBeNull();
  await recordChapterDownloadFailure(failure(1));
  await recordChapterDownloadFailure(failure(2));
  sqlite.exec("DELETE FROM chapter WHERE id=2");
  expect((await listChapterDownloadFailures()).map((row) => row.chapterId)).toEqual([1]);
  expect(await clearChapterDownloadFailures([1, 1, 2])).toBe(1);
  expect(await listChapterDownloadFailures()).toEqual([]);
});
