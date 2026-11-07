import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import {
  resumeStoppedNovelDownloadGoal, excludeChaptersFromDownloadGoals, getNovelDownloadGoal, listDownloadGoalExcludedChapterIds,
  listDownloadGoalNovels, listGoalNovelIdsForDownloadScope, listLibraryNovelsWithoutDownloadGoal, listNovelDownloadGoals,
  setNovelDownloadGoal,
} from "./novel-download-goal";

let sqlite: DatabaseSync;

const params = (values: unknown[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])) as never;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/include_str!\("([^"]+)"\)/g)) {
    sqlite.exec(readFileSync(`src-tauri/src/${match[1]}`, "utf8"));
  }
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/one','One'),(2,'source','/two','Two')");
  vi.mocked(getDb).mockResolvedValue({
    select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql).all(params(values)),
    execute: async (sql: string, values: unknown[] = []) =>
      ({ rowsAffected: Number(sqlite.prepare(sql).run(params(values)).changes), lastInsertId: 0 }),
  } as never);
});

afterEach(() => { sqlite.close(); });

it("stores, replaces and clears one goal per novel", async () => {
  expect(await setNovelDownloadGoal(1, { kind: "keep_ahead", count: 3 }, 10)).toBe(true);
  expect(await setNovelDownloadGoal(2, { kind: "entire" }, 20)).toBe(true);
  expect(await getNovelDownloadGoal(1)).toEqual({ novelId: 1, goal: { kind: "keep_ahead", count: 3 }, updatedAt: 10 });

  expect(await setNovelDownloadGoal(1, { kind: "all_remaining" }, 30)).toBe(true);
  expect(await listNovelDownloadGoals()).toEqual([
    { novelId: 1, goal: { kind: "all_remaining" }, updatedAt: 30 },
    { novelId: 2, goal: { kind: "entire" }, updatedAt: 20 },
  ]);

  expect(await setNovelDownloadGoal(1, null)).toBe(true);
  expect(await getNovelDownloadGoal(1)).toBeNull();
});

it("reports a missing novel instead of writing an orphan goal", async () => {
  expect(await setNovelDownloadGoal(99, { kind: "entire" })).toBe(false);
  expect(await listNovelDownloadGoals()).toEqual([]);
});

it("drops the goal with its novel", async () => {
  await setNovelDownloadGoal(2, { kind: "keep_ahead", count: 5 });
  sqlite.exec("DELETE FROM novel WHERE id=2");
  expect(await listNovelDownloadGoals()).toEqual([]);
});

it("lists only active library source novels and retains positive legacy rows without letting them bypass eligibility", async () => {
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library,last_read_at) VALUES
    (3,'source','/active','Active',1,500),(4,'source','/stale','Stale',1,100),(5,'source','/browsed','Browsed',0,900),
    (7,'source','/legacy-active','Legacy active',1,600);
    INSERT INTO novel(id,plugin_id,path,name,is_local,in_library,last_read_at) VALUES(6,'local','/local','Local',1,1,800);
    UPDATE novel SET last_read_at=200 WHERE id=2`);
  await setNovelDownloadGoal(2, { kind: "entire" });
  await setNovelDownloadGoal(4, { kind: "entire" });
  await setNovelDownloadGoal(5, { kind: "all_remaining" });
  await setNovelDownloadGoal(6, { kind: "entire" });
  await setNovelDownloadGoal(7, { kind: "keep_ahead", count: 30 });

  expect((await listDownloadGoalNovels(400)).map((novel) => [novel.id, novel.goal?.kind ?? null]))
    .toEqual([[7, "keep_ahead"], [3, null]]);
  expect(await listDownloadGoalNovels(null)).toEqual([]);
  expect(await listDownloadGoalNovels(400, [3, 4])).toEqual([
    { id: 3, pluginId: "source", path: "/active", name: "Active", lastReadAt: 500, goal: null },
  ]);
  expect(await listDownloadGoalNovels(400, [])).toEqual([]);
  expect(await listNovelDownloadGoals()).toHaveLength(5);
});

it("keeps an explicit None out of goal work, including the default keep-ahead", async () => {
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library,last_read_at) VALUES
    (3,'source','/active','Active',1,500),(4,'source','/opted-out','Opted out',1,600)`);
  expect(await setNovelDownloadGoal(4, { kind: "none" }, 10)).toBe(true);
  expect(await getNovelDownloadGoal(4)).toEqual({ novelId: 4, goal: { kind: "none" }, updatedAt: 10 });
  expect((await listDownloadGoalNovels(400)).map((novel) => novel.id)).toEqual([3]);
  expect(await listDownloadGoalNovels(400, [4])).toEqual([]);
  expect(await listGoalNovelIdsForDownloadScope("novel", [4])).toEqual([]);
  expect(await listGoalNovelIdsForDownloadScope("all", [])).toEqual([]);

  expect(await setNovelDownloadGoal(4, null)).toBe(true);
  expect((await listDownloadGoalNovels(400)).map((novel) => novel.id)).toEqual([4, 3]);
});

it("finds the goal novels a download deletion touches", async () => {
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(10,1,'/a','A',1),(20,2,'/b','B',1)");
  await setNovelDownloadGoal(2, { kind: "keep_ahead", count: 3 });
  sqlite.exec("UPDATE novel SET in_library=1,last_read_at=500 WHERE id=2");
  expect(await listGoalNovelIdsForDownloadScope("chapter", [10, 20, 20], 400)).toEqual([2]);
  expect(await listGoalNovelIdsForDownloadScope("novel", [1])).toEqual([]);
  expect(await listGoalNovelIdsForDownloadScope("novel", [1, 2], 400)).toEqual([2]);
  expect(await listGoalNovelIdsForDownloadScope("all", [], 400)).toEqual([2]);
  expect(await listGoalNovelIdsForDownloadScope("all", [], null)).toEqual([]);
});

it("counts the default keep-ahead of active library novels as a goal a deletion touches", async () => {
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library,last_read_at) VALUES
    (3,'source','/active','Active',1,500),(4,'source','/stale','Stale',1,100),(5,'source','/opted-out','Opted out',1,500);
    INSERT INTO chapter(id,novel_id,path,name,position) VALUES(30,3,'/a','A',1),(40,4,'/b','B',1),(50,5,'/c','C',1)`);
  await setNovelDownloadGoal(5, { kind: "none" });
  expect(await listGoalNovelIdsForDownloadScope("chapter", [30, 40, 50], 400)).toEqual([3]);
  expect(await listGoalNovelIdsForDownloadScope("novel", [3, 4, 5], 400)).toEqual([3]);
  expect(await listGoalNovelIdsForDownloadScope("all", [], 400)).toEqual([3]);
  expect(await listGoalNovelIdsForDownloadScope("all", [], null)).toEqual([]);
});

it("preserves goal exclusions across global policy use and removes them only with their chapter", async () => {
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(10,1,'/a','A',1),(11,1,'/b','B',2),(20,2,'/c','C',1)");
  await excludeChaptersFromDownloadGoals([11, 10, 11, 20, 99], 5);
  await excludeChaptersFromDownloadGoals([10], 9);
  expect(await listDownloadGoalExcludedChapterIds(1)).toEqual([10, 11]);
  expect(sqlite.prepare("SELECT created_at AS createdAt FROM chapter_download_goal_exclusion WHERE chapter_id=10").get())
    .toEqual({ createdAt: 5 });

  await setNovelDownloadGoal(1, { kind: "none" });
  expect(await resumeStoppedNovelDownloadGoal(1)).toBe(true);
  expect(await listDownloadGoalExcludedChapterIds(1)).toEqual([10, 11]);
  expect(await listDownloadGoalExcludedChapterIds(2)).toEqual([20]);
  sqlite.exec("DELETE FROM chapter WHERE id=20");
  expect(await listDownloadGoalExcludedChapterIds(2)).toEqual([]);
});

it("lists library source novels that follow the default", async () => {
  sqlite.exec(`UPDATE novel SET in_library=1 WHERE id IN (1,2);
    INSERT INTO novel(id,plugin_id,path,name,is_local,in_library) VALUES(3,'local','/local','Local',1,1),(4,'source','/out','Out',0,0)`);
  await setNovelDownloadGoal(2, { kind: "none" });
  expect(await listLibraryNovelsWithoutDownloadGoal()).toEqual([{ id: 1, pluginId: "source" }]);
});

it("resumes only a stored pause without changing downloaded chapters, queued requests, failures or exclusions", async () => {
  sqlite.exec(`INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded) VALUES(10,1,'/a','A',1,1);
    INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms) VALUES(10,'{"id":10,"goal":true}',1,1);
    INSERT INTO chapter_download_failure(chapter_id,plugin_id,failure_class,message_summary,attempts,job_json,updated_at)
      VALUES(10,'source','transient','Held failure',1,'{"id":10}',1)`);
  await excludeChaptersFromDownloadGoals([10], 5);
  await setNovelDownloadGoal(1, { kind: "none" }, 6);
  await setNovelDownloadGoal(2, { kind: "entire" }, 7);
  const tables = ["chapter", "chapter_download_queue", "chapter_download_failure", "chapter_download_goal_exclusion"];
  const before = tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all());

  expect(await resumeStoppedNovelDownloadGoal(1)).toBe(true);
  expect(await resumeStoppedNovelDownloadGoal(1)).toBe(false);
  expect(await resumeStoppedNovelDownloadGoal(2)).toBe(false);
  expect(await resumeStoppedNovelDownloadGoal(99)).toBe(false);
  expect(await getNovelDownloadGoal(1)).toBeNull();
  expect(await getNovelDownloadGoal(2)).toEqual({ novelId: 2, goal: { kind: "entire" }, updatedAt: 7 });
  expect(tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
});
