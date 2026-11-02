import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";
import * as schema from "./schema";

function applyRegisteredMigrations(db: DatabaseSync, fromVersion = 0): void {
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g)) {
    if (Number(match[1]) > fromVersion) db.exec(readFileSync(`src-tauri/src/${match[2]}`, "utf8"));
  }
}

it("creates every current Drizzle table and column from registered migrations", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyRegisteredMigrations(db);
    for (const table of Object.values(schema).filter((value) => is(value, SQLiteTable))) {
      const config = getTableConfig(table);
      const columns = db.prepare(`PRAGMA table_info('${config.name}')`).all() as { name: string }[];
      expect(columns.map((column) => column.name).sort(), config.name)
        .toEqual(config.columns.map((column) => column.name).sort());
    }
    db.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/work','Work')");
    db.exec("INSERT INTO chapter(novel_id,path,name,position,stored_content_type) VALUES(1,'/chapter','Chapter',1,'html')");
    expect(db.prepare("SELECT total_chapters FROM novel_stats WHERE novel_id=1").get()).toEqual({ total_chapters: 1 });
    db.exec("INSERT INTO vpn_gate_server_verdict(ip,verdict) VALUES('198.51.100.7','works')");
    expect(() => db.exec("INSERT INTO vpn_gate_server_verdict(ip,verdict) VALUES('198.51.100.8','unknown')")).toThrow();
  } finally { db.close(); }
});

it("upgrades populated v1 storage and reopens without losing library, chapters or ordinary queue state", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(".tmp/vpn-plan-migration-");
  const path = join(directory, "norea.db");
  let db = new DatabaseSync(path);
  try {
    db.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
    db.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1);
      INSERT INTO chapter(id,novel_id,path,name,position,progress,is_downloaded,content_bytes)
      VALUES(1,1,'/chapter','Chapter',1,73,1,456);
      INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms,leased_at_ms,attempt_count)
      VALUES(1,'{"id":1,"pluginId":"source","chapterPath":"/chapter","title":"Chapter"}',10,20,30,4)`);
    const library = db.prepare("SELECT * FROM novel").all();
    const chapters = db.prepare("SELECT * FROM chapter").all();
    const queue = db.prepare("SELECT * FROM chapter_download_queue").all();
    applyRegisteredMigrations(db, 1);
    expect(db.prepare("PRAGMA table_info('vpn_download_plan')").all().map(column => column.name))
      .toEqual(["id", "payload", "revision"]);
    db.exec("INSERT INTO vpn_download_plan(id,payload,revision) VALUES('plan','retained payload',3)");
    db.close();
    db = new DatabaseSync(path);
    expect(db.prepare("SELECT * FROM novel").all()).toEqual(library);
    expect(db.prepare("SELECT * FROM chapter").all()).toEqual(chapters);
    expect(db.prepare("SELECT * FROM chapter_download_queue").all()).toEqual(queue);
    expect(db.prepare("SELECT * FROM vpn_download_plan").all())
      .toEqual([{ id: "plan", payload: "retained payload", revision: 3 }]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

it("upgrades v2 plans with shared batch membership without changing queued jobs or recovery state", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
    db.exec(readFileSync("src-tauri/src/migrations/0002_vpn_download_plans.sql", "utf8"));
    db.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/work','Work')");
    const payload = { revision: 7, ranges: [{ checkpoint: 2, attemptedProfileIds: ["failed"], userPaused: true }] };
    for (const id of ["first", "second", "mixed", "empty"]) {
      db.prepare("INSERT INTO vpn_download_plan VALUES(?,?,7)").run(id, JSON.stringify({ id, ...payload }));
    }
    for (const [index, owner, batchId] of [[1, "first", "shared"], [2, "second", "shared"], [3, "mixed", "one"], [4, "mixed", "two"]] as const) {
      db.prepare("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(?,1,?,'Chapter',?)").run(index, `/${index}`, index);
      db.prepare("INSERT INTO chapter_download_queue VALUES(?,?,10,20,30,4)")
        .run(index, JSON.stringify({ id: index, vpnPlanId: owner, batchId }));
    }
    const queue = db.prepare("SELECT * FROM chapter_download_queue ORDER BY chapter_id").all();
    applyRegisteredMigrations(db, 2);
    const migrated = db.prepare("SELECT id,payload,revision FROM vpn_download_plan ORDER BY id").all();
    expect(migrated.map(row => JSON.parse(String(row.payload)).batchId))
      .toEqual(["legacy-vpn-plan:empty", "shared", "legacy-vpn-plan:mixed", "shared"]);
    for (const row of migrated) {
      expect(JSON.parse(String(row.payload))).toMatchObject(payload);
      expect(row.revision).toBe(7);
    }
    expect(db.prepare("SELECT * FROM chapter_download_queue ORDER BY chapter_id").all()).toEqual(queue);
    db.exec(`INSERT INTO vpn_download_profile_issue
      (batch_id,ip,profile_id,profile_hash,plan_id,range_id,generation,cause,recorded_at,excluded,revision)
      VALUES('shared','192.0.2.1','failed','hash','first','range',4,'captcha',100,1,1)`);
    expect(() => db.exec(`UPDATE vpn_download_profile_issue SET cause='cookie=secret'`)).toThrow();
    expect(() => db.exec(`UPDATE vpn_download_profile_issue SET excluded=2`)).toThrow();
    expect(db.prepare("SELECT cause,excluded FROM vpn_download_profile_issue").get()).toEqual({ cause: "captcha", excluded: 1 });
  } finally { db.close(); }
});
