import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import { getNovelFreshness, recordNovelCheck } from "./novel-freshness";

let sqlite: DatabaseSync;
const params = (values: unknown[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/include_str!\("([^"]+)"\)/g)) {
    sqlite.exec(readFileSync(`src-tauri/src/${match[1]}`, "utf8"));
  }
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/one','One')");
  vi.mocked(getDb).mockResolvedValue({
    select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql).all(params(values)),
    execute: async (sql: string, values: unknown[] = []) =>
      ({ rowsAffected: Number(sqlite.prepare(sql).run(params(values)).changes), lastInsertId: 0 }),
  } as never);
});

afterEach(() => { sqlite.close(); });

it("counts failures until a check succeeds and keeps when chapters were last found", async () => {
  await recordNovelCheck(1, { ok: false }, 10);
  await recordNovelCheck(1, { ok: false }, 20);
  expect(await getNovelFreshness(1)).toMatchObject({ lastCheckedAt: 20, lastSuccessAt: null, consecutiveFailures: 2 });

  await recordNovelCheck(1, { ok: true, newChapters: 3 }, 30);
  await recordNovelCheck(1, { ok: true, newChapters: 0 }, 40);
  expect(await getNovelFreshness(1)).toEqual({
    novelId: 1, lastCheckedAt: 40, lastSuccessAt: 40, consecutiveFailures: 0, lastNewChapterAt: 30, coverFetchedAt: null,
  });
});

it("skips a novel that no longer exists", async () => {
  await recordNovelCheck(99, { ok: true, newChapters: 1 }, 10);
  await recordNovelCheck(99, { ok: false }, 10);
  expect(await getNovelFreshness(99)).toBeNull();
});
