import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn() }));
import { getDb } from "../client";
import { getNovelDownloadGoal, listNovelDownloadGoals, setNovelDownloadGoal } from "./novel-download-goal";

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
