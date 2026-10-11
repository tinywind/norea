import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { findMatchingNovelIdentityInDb, reconcileImportedNovelIdentityInDb } from "./novel-identity";

let sqlite: DatabaseSync;
let db: Database;
const identity = { pluginId: "source", path: "/webtoon/10557", name: "Building owner" };
const folder = "norea-folder:Building-owner-webtoon-10557";
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  db = {
    select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql).all(Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value])) as never),
    execute: async (sql: string, values: unknown[] = []) => ({ rowsAffected: Number(sqlite.prepare(sql).run(Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value])) as never).changes) }),
  } as Database;
});
afterEach(() => sqlite.close());

it("reuses a folder import and preserves chapter ids, downloads and reading state", async () => {
  sqlite.prepare("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(7,'source',?,'Imported',1)").run(identity.path);
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,is_downloaded) VALUES(9,7,'norea-folder:1','Old','1',1,73,1)");
  expect(await reconcileImportedNovelIdentityInDb(db, identity, [{ path: "/chapter/1", chapterNumber: "1" }])).toEqual({ id: 7, changed: true });
  expect(sqlite.prepare("SELECT id,path,in_library FROM novel").get()).toEqual({ id: 7, path: identity.path, in_library: 1 });
  expect(sqlite.prepare("SELECT id,path,progress,is_downloaded FROM chapter").get()).toEqual({ id: 9, path: "/chapter/1", progress: 73, is_downloaded: 1 });
});

it("matches exact plugin paths without deriving identity from URLs or folder names", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(7,'source','/webtoon/10557','Building owner')");
  expect(await findMatchingNovelIdentityInDb(db, identity)).toMatchObject({ id: 7, path: identity.path });
  expect(await findMatchingNovelIdentityInDb(db, { ...identity, path: `https://old.test${identity.path}` })).toBeNull();
  expect(await findMatchingNovelIdentityInDb(db, { pluginId: "source", path: folder, name: "Imported" })).toBeNull();
  expect(await findMatchingNovelIdentityInDb(db, { pluginId: "source", path: "norea-folder:Another-webtoon-10557", name: "Imported" })).toBeNull();
  expect(await findMatchingNovelIdentityInDb(db, { ...identity, pluginId: "different" })).toBeNull();
});

it("does not match works by colliding canonical folder names", async () => {
  sqlite.exec("INSERT INTO novel(plugin_id,path,name) VALUES('source','/webtoon/10557','Building owner'),('source','/webtoon-10557','Building owner')");
  expect(await findMatchingNovelIdentityInDb(db, { pluginId: "source", path: folder, name: "Imported" })).toBeNull();
});

it("does not replace ambiguous chapter numbers", async () => {
  sqlite.prepare("INSERT INTO novel(id,plugin_id,path,name) VALUES(7,'source',?,'Imported')").run(identity.path);
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,chapter_number,position) VALUES(7,'norea-folder:1','A','1',1),(7,'norea-folder:one','B','1',2)");
  await expect(reconcileImportedNovelIdentityInDb(db, identity, [{ path: "/chapter/1", chapterNumber: "1" }])).rejects.toThrow("ambiguous");
  expect(sqlite.prepare("SELECT path FROM novel").get()).toEqual({ path: identity.path });
});
