import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import {
  countRecentChecksBySource, getLatestLibraryCheckAt, getNovelFreshness, listCheckCandidates, recordNovelCheck,
} from "./novel-freshness";

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

it("lists library source novels with their reading state, goal and freshness, and counts recent checks per source", async () => {
  sqlite.exec(`UPDATE novel SET in_library=1,last_read_at=50,status='Ongoing' WHERE id=1;
    INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(2,'other','/two','Two',1),(3,'source','/three','Three',0);
    INSERT INTO novel(id,plugin_id,path,name,in_library,is_local) VALUES(4,'local','/four','Four',1,1);
    INSERT INTO chapter(novel_id,path,name,position,unread) VALUES(1,'/a','A',1,0),(1,'/b','B',2,1);
    INSERT INTO novel_download_goal VALUES(1,'entire',NULL,1),(2,'none',NULL,1)`);
  await recordNovelCheck(1, { ok: false }, 900);
  await recordNovelCheck(2, { ok: true, newChapters: 0 }, 100);
  expect(await listCheckCandidates()).toEqual([
    { novelId: 1, pluginId: "source", status: "Ongoing", lastReadAt: 50, lastCheckedAt: 900, consecutiveFailures: 1,
      totalChapters: 2, unreadChapters: 1, hasGoal: true },
    { novelId: 2, pluginId: "other", status: null, lastReadAt: null, lastCheckedAt: 100, consecutiveFailures: 0,
      totalChapters: 0, unreadChapters: 0, hasGoal: false },
  ]);
  expect(await countRecentChecksBySource(500)).toEqual(new Map([["source", 1]]));
});

it("reports when a library novel was last checked, ignoring novels outside the library", async () => {
  expect(await getLatestLibraryCheckAt()).toBeNull();
  sqlite.exec(`UPDATE novel SET in_library=1 WHERE id=1;
    INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(2,'source','/two','Two',0)`);
  await recordNovelCheck(1, { ok: false }, 30);
  await recordNovelCheck(2, { ok: true, newChapters: 0 }, 90);
  expect(await getLatestLibraryCheckAt()).toBe(30);
});
