import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";
import * as schema from "./schema";

function applyRegisteredMigrations(db: DatabaseSync, fromVersion = 0, toVersion = Infinity): void {
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g)) {
    if (Number(match[1]) > fromVersion && Number(match[1]) <= toVersion) db.exec(readFileSync(`src-tauri/src/${match[2]}`, "utf8"));
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
    expect(db.prepare("SELECT * FROM chapter").all())
      .toEqual(chapters.map((row) => ({ ...(row as object), found_by_check: 0 })));
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
    applyRegisteredMigrations(db, 2, 3);
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

it("upgrades populated v3 storage to chapter download failure tracking without changing existing rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyRegisteredMigrations(db, 0, 3);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='chapter_download_failure'").all()).toEqual([]);
    db.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1);
      INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40),(2,1,'/two','Two',2,0);
      INSERT INTO chapter_download_queue VALUES(1,'{"id":1,"pluginId":"source","chapterPath":"/one","title":"One"}',10,20,NULL,0);
      INSERT INTO vpn_download_plan VALUES('plan','{"batchId":"batch"}',2)`);
    const before = ["chapter", "chapter_download_queue", "vpn_download_plan"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    applyRegisteredMigrations(db, 3, 4);
    expect(["chapter", "chapter_download_queue", "vpn_download_plan"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()))
      .toEqual(before);
    db.exec(`INSERT INTO chapter_download_failure VALUES(2,'source','media-incomplete','Missing images',NULL,1,NULL,'{}',10)`);
    expect(() => db.exec(`INSERT INTO chapter_download_failure VALUES(1,'source','unknown','x',NULL,1,NULL,'{}',10)`)).toThrow();
    expect(() => db.exec(`INSERT INTO chapter_download_failure VALUES(1,'source','content','x',NULL,0,NULL,'{}',10)`)).toThrow();
    db.exec("DELETE FROM chapter WHERE id=2");
    expect(db.prepare("SELECT COUNT(*) AS count FROM chapter_download_failure").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

it("upgrades populated v4 storage to novel download goals without changing existing rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyRegisteredMigrations(db, 0, 4);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='novel_download_goal'").all()).toEqual([]);
    db.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',0);
      INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40);
      INSERT INTO chapter_download_queue VALUES(1,'{"id":1,"pluginId":"source","chapterPath":"/one","title":"One"}',10,20,NULL,0);
      INSERT INTO chapter_download_failure VALUES(1,'source','transient','Timed out',NULL,1,30000,'{}',10)`);
    const tables = ["novel", "chapter", "chapter_download_queue", "chapter_download_failure"];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    applyRegisteredMigrations(db, 4, 5);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    db.exec("INSERT INTO novel_download_goal VALUES(1,'keep_ahead',3,10),(2,'all_remaining',NULL,10)");
    expect(() => db.exec("INSERT INTO novel_download_goal VALUES(1,'entire',NULL,10)")).toThrow();
    expect(() => db.exec("UPDATE novel_download_goal SET count=0 WHERE novel_id=1")).toThrow();
    expect(() => db.exec("UPDATE novel_download_goal SET count=4 WHERE novel_id=2")).toThrow();
    expect(() => db.exec("UPDATE novel_download_goal SET kind='next10' WHERE novel_id=2")).toThrow();
    db.exec("DELETE FROM novel WHERE id=2");
    expect(db.prepare("SELECT novel_id AS novelId,kind,count FROM novel_download_goal").all())
      .toEqual([{ novelId: 1, kind: "keep_ahead", count: 3 }]);
  } finally { db.close(); }
});

it("upgrades populated v5 storage to explicit goal opt-outs and persisted exclusions without changing existing rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    applyRegisteredMigrations(db, 0, 5);
    db.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',1),(3,'source','/third','Third',1);
      INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40),(2,2,'/two','Two',1,0);
      INSERT INTO chapter_download_failure VALUES(1,'source','transient','Timed out',NULL,1,30000,'{}',10);
      INSERT INTO novel_download_goal VALUES(1,'keep_ahead',5,10),(2,'entire',NULL,20)`);
    expect(() => db.exec("INSERT INTO novel_download_goal VALUES(3,'none',NULL,30)")).toThrow();
    const tables = ["novel", "chapter", "chapter_download_failure", "novel_download_goal"];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    applyRegisteredMigrations(db, 5, 6);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    db.exec("INSERT INTO novel_download_goal VALUES(3,'none',NULL,30)");
    expect(() => db.exec("UPDATE novel_download_goal SET count=2 WHERE novel_id=3")).toThrow();
    expect(() => db.exec("UPDATE novel_download_goal SET kind='skip' WHERE novel_id=3")).toThrow();
    db.exec("INSERT INTO chapter_download_goal_exclusion VALUES(1,50),(2,60)");
    expect(() => db.exec("INSERT INTO chapter_download_goal_exclusion VALUES(99,70)")).toThrow();
    db.exec("DELETE FROM novel WHERE id IN (2,3)");
    expect(db.prepare("SELECT chapter_id AS chapterId FROM chapter_download_goal_exclusion").all()).toEqual([{ chapterId: 1 }]);
    expect(db.prepare("SELECT novel_id AS novelId,kind FROM novel_download_goal").all()).toEqual([{ novelId: 1, kind: "keep_ahead" }]);
  } finally { db.close(); }
});

it("upgrades populated v6 storage to freshness records without flagging any existing chapter", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyRegisteredMigrations(db, 0, 6);
    db.exec(`INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',1);
      INSERT INTO chapter(id,novel_id,path,name,position,progress,found_at) VALUES(1,1,'/one','One',1,40,500),(2,2,'/two','Two',1,0,600);
      INSERT INTO novel_download_goal VALUES(1,'none',NULL,10);
      INSERT INTO chapter_download_goal_exclusion VALUES(2,20)`);
    const tables = ["novel", "novel_download_goal", "chapter_download_goal_exclusion"];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const chapters = db.prepare("SELECT * FROM chapter ORDER BY id").all();
    applyRegisteredMigrations(db, 6);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.prepare("SELECT * FROM chapter ORDER BY id").all())
      .toEqual(chapters.map((row) => ({ ...(row as object), found_by_check: 0 })));
    expect(() => db.exec("UPDATE chapter SET found_by_check=2 WHERE id=1")).toThrow();
    db.exec("INSERT INTO novel_freshness(novel_id,last_checked_at,consecutive_failures) VALUES(1,100,2),(2,200,0)");
    expect(() => db.exec("INSERT INTO novel_freshness(novel_id) VALUES(99)")).toThrow();
    expect(() => db.exec("UPDATE novel_freshness SET last_checked_at=-1 WHERE novel_id=1")).toThrow();
    db.exec("DELETE FROM novel WHERE id=2");
    expect(db.prepare("SELECT novel_id AS novelId,consecutive_failures AS failures FROM novel_freshness").all())
      .toEqual([{ novelId: 1, failures: 2 }]);
  } finally { db.close(); }
});

it("upgrades populated v7 storage to a repository list that keeps the saved repository first", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyRegisteredMigrations(db, 0, 7);
    db.exec(`INSERT INTO repository(id,url,name,added_at) VALUES(1,'https://repo.test/plugins.json','Saved',50);
      INSERT INTO repository_index_cache(repo_url,items_json) VALUES('https://repo.test/plugins.json',
        '[{"id":"bound","url":"https://repo.test/bound.js"},"odd",{"id":"github","url":"https://repo.test/github.js"},{"id":"same-id","url":"https://repo.test/same-id.js"}]');
      INSERT INTO repository_index_cache(repo_url,items_json) VALUES('https://broken.test/plugins.json','not json');
      INSERT INTO installed_plugin(id,name,lang,version,icon_url,source_url,source_code) VALUES
        ('bound','Bound','en','1','','https://repo.test/bound.js','a'),
        ('github:shelf','Shelf','en','1','','https://repo.test/github.js','b'),
        ('same-id','Same id','en','1','','https://elsewhere.test/bound.js','c'),
        ('local','Local','en','1','','local:local.js','d')`);
    const cache = db.prepare("SELECT * FROM repository_index_cache ORDER BY repo_url").all();
    applyRegisteredMigrations(db, 7);
    expect(db.prepare("SELECT id,url,name,added_at AS addedAt,priority,enabled FROM repository").all())
      .toEqual([{ id: 1, url: "https://repo.test/plugins.json", name: "Saved", addedAt: 50, priority: 1, enabled: 1 }]);
    expect(db.prepare("SELECT id,repository_url AS repositoryUrl,source_code AS code FROM installed_plugin ORDER BY id").all()).toEqual([
      { id: "bound", repositoryUrl: "https://repo.test/plugins.json", code: "a" },
      { id: "github:shelf", repositoryUrl: "https://repo.test/plugins.json", code: "b" },
      { id: "local", repositoryUrl: null, code: "d" },
      { id: "same-id", repositoryUrl: null, code: "c" },
    ]);
    expect(db.prepare("SELECT * FROM repository_index_cache ORDER BY repo_url").all()).toEqual(cache);
    db.exec("INSERT INTO repository(url,priority,enabled) VALUES('https://second.test/plugins.json',2,0)");
    expect(() => db.exec("INSERT INTO repository(url) VALUES('https://second.test/plugins.json')")).toThrow();
    expect(() => db.exec("UPDATE repository SET enabled=2 WHERE id=1")).toThrow();
    expect(() => db.exec("UPDATE repository SET priority=0 WHERE id=1")).toThrow();
  } finally { db.close(); }
});

it("upgrades v9 with durable chapter composition without changing library, content or reading data", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(".tmp/chapter-composition-migration-");
  const file = join(directory, "norea.db");
  let db = new DatabaseSync(file);
  try {
    applyRegisteredMigrations(db, 0, 9);
    db.exec("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/book','Book',1)");
    db.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,bookmark,unread,is_downloaded,content_bytes,media_bytes) VALUES(1,1,'/chapter','Chapter','42',1,76,1,0,1,123,45)");
    const novel = db.prepare("SELECT * FROM novel").get();
    const chapter = db.prepare("SELECT * FROM chapter").get();
    applyRegisteredMigrations(db, 9);
    db.exec("DELETE FROM work_metadata_dirty");
    db.prepare("INSERT INTO novel_chapter_composition(novel_id,payload) VALUES(1,?)")
      .run(JSON.stringify({ version: 1, updatedAt: 42, entries: [] }));
    expect(db.prepare("SELECT * FROM work_metadata_dirty").all()).toEqual([{ plugin_id: "source", path: "/book" }]);
    db.close(); db = new DatabaseSync(file);
    expect(db.prepare("SELECT * FROM novel").get()).toEqual(novel);
    expect(db.prepare("SELECT * FROM chapter").get()).toEqual(chapter);
    expect(JSON.parse((db.prepare("SELECT payload FROM novel_chapter_composition").get() as { payload: string }).payload))
      .toEqual({ version: 1, updatedAt: 42, entries: [] });
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});
