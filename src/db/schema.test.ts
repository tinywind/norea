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
      .toEqual(chapters.map((row) => {
        const { unread: _dropped, ...rest } = row as Record<string, unknown>;
        return { ...rest, found_by_check: 0 };
      }));
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
      .toEqual(chapters.map((row) => {
        const { unread: _dropped, ...rest } = row as Record<string, unknown>;
        return { ...rest, found_by_check: 0 };
      }));
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
    const { unread: _droppedUnread, ...expectedChapter } = chapter as Record<string, unknown>;
    expect(db.prepare("SELECT * FROM chapter").get()).toEqual({ ...expectedChapter, progress: 100 });
    expect(JSON.parse((db.prepare("SELECT payload FROM novel_chapter_composition").get() as { payload: string }).payload))
      .toEqual({ version: 1, updatedAt: 42, entries: [] });
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

it("upgrades v11 content-sync journal triggers to record incomplete-media bodies and chapter path renames", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyRegisteredMigrations(db, 0, 11);
    db.exec(`INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(1,'source','work-1','/work','Work');
      INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,content_bytes,media_repair_needed)
      VALUES(1,1,'/incomplete','Incomplete',1,0,120,1),(2,1,'/empty','Empty',2,0,0,0)`);
    db.exec("DELETE FROM content_sync_journal");

    applyRegisteredMigrations(db, 11, 12);
    expect(db.prepare("SELECT state_key FROM content_sync_journal").all()).toEqual([
      { state_key: 'content:["source","/work","/incomplete"]' },
    ]);

    db.exec("DELETE FROM content_sync_journal");
    db.exec("INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,content_bytes) VALUES(3,1,'/body-only','Body',3,0,80)");
    expect(db.prepare("SELECT state_key FROM content_sync_journal").all()).toEqual([
      { state_key: 'content:["source","/work","/body-only"]' },
    ]);

    db.exec("DELETE FROM content_sync_journal");
    db.exec("UPDATE chapter SET path='/renamed' WHERE id=3");
    expect(db.prepare("SELECT state_key FROM content_sync_journal ORDER BY state_key").all()).toEqual([
      { state_key: 'content:["source","/work","/body-only"]' },
      { state_key: 'content:["source","/work","/renamed"]' },
    ]);

    db.exec("DELETE FROM content_sync_journal");
    db.exec("UPDATE novel SET name='Renamed Work' WHERE id=1");
    expect(db.prepare("SELECT state_key FROM content_sync_journal ORDER BY state_key").all()).toEqual([
      { state_key: 'content:["source","/work","/incomplete"]' },
      { state_key: 'content:["source","/work","/renamed"]' },
    ]);
  } finally {
    db.close();
  }
});

it("upgrades populated v12 storage to one user override per novel without changing existing rows", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(".tmp/novel-override-migration-");
  const file = join(directory, "norea.db");
  let db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    applyRegisteredMigrations(db, 0, 12);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='novel_override'").all()).toEqual([]);
    db.exec(`INSERT INTO novel(id,plugin_id,source_novel_id,path,name,status,in_library) VALUES(1,'source','work-1','/work','Work','Ongoing',1),(2,'source','work-2','/other','Other',NULL,1);
      INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40);
      INSERT INTO novel_download_goal VALUES(1,'keep_ahead',3,10);
      INSERT INTO novel_chapter_composition VALUES(1,'{"version":1,"updatedAt":5,"entries":[]}')`);
    const tables = ["novel", "chapter", "novel_download_goal", "novel_chapter_composition", "work_metadata_dirty"];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    applyRegisteredMigrations(db, 12, 13);
    const payload = JSON.stringify({ fields: { completed: { value: true, updatedAt: 1763350000000 } } });
    db.prepare("INSERT INTO novel_override(novel_id,payload) VALUES(1,?),(2,?)").run(payload, payload);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(() => db.prepare("INSERT INTO novel_override(novel_id,payload) VALUES(1,?)").run(payload)).toThrow();
    expect(() => db.prepare("INSERT INTO novel_override(novel_id,payload) VALUES(99,?)").run(payload)).toThrow();
    db.exec("DELETE FROM novel WHERE id=2");
    db.close(); db = new DatabaseSync(file);
    expect(db.prepare("SELECT novel_id AS novelId,payload FROM novel_override").all()).toEqual([{ novelId: 1, payload }]);
    expect(db.prepare("SELECT json_extract(payload,'$.fields.completed.value') AS completed FROM novel_override").get())
      .toEqual({ completed: 1 });
    applyRegisteredMigrations(db, 13, 14);
    expect(db.prepare("SELECT json_extract(payload,'$.fields.status.value') AS status, json_extract(payload,'$.fields.status.updatedAt') AS updatedAt, json_type(payload,'$.fields.completed') AS completedType FROM novel_override WHERE novel_id=1").get())
      .toEqual({ status: "Completed", updatedAt: 1763350000000, completedType: null });
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

it("upgrades populated v14 user_state_operation rows to track acknowledged_at without altering pending or conflict rows", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(".tmp/user-state-retention-migration-");
  const file = join(directory, "norea.db");
  let db = new DatabaseSync(file);
  try {
    applyRegisteredMigrations(db, 0, 14);
    db.exec(`INSERT INTO user_state_operation(operation_id,namespace,entity_key,intent_sequence,payload,status,receipt) VALUES
      ('op-ack','ns','["reading","k1"]',1,'{}','acknowledged','{"status":"applied"}'),
      ('op-pending','ns','["reading","k2"]',2,'{}','pending',NULL),
      ('op-conflict','ns','["reading","k3"]',3,'{}','conflict','{"status":"conflict"}')`);

    applyRegisteredMigrations(db, 14, 15);
    db.close();
    db = new DatabaseSync(file);

    const rows = db.prepare("SELECT operation_id AS id, status, receipt, acknowledged_at AS acknowledgedAt FROM user_state_operation ORDER BY intent_sequence").all() as {
      id: string;
      status: string;
      receipt: string | null;
      acknowledgedAt: number | null;
    }[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: "op-ack", status: "acknowledged", receipt: '{"status":"applied"}' });
    expect(typeof rows[0]!.acknowledgedAt).toBe("number");
    expect(rows[0]!.acknowledgedAt!).toBeGreaterThanOrEqual(0);
    expect(rows[1]).toEqual({ id: "op-pending", status: "pending", receipt: null, acknowledgedAt: null });
    expect(rows[2]).toEqual({ id: "op-conflict", status: "conflict", receipt: '{"status":"conflict"}', acknowledgedAt: null });

    expect(() => db.exec(
      "INSERT INTO user_state_operation(operation_id,namespace,entity_key,intent_sequence,payload,status,acknowledged_at) VALUES('op-bad','ns','k4',4,'{}','acknowledged',-1)",
    )).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='user_state_operation_acknowledged_idx'").get())
      .toEqual({ name: "user_state_operation_acknowledged_idx" });
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

it("upgrades populated v15 user_state_workspace rows with seed_suppressed and seed_cutoff_at checks", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(".tmp/user-state-epoch-retention-migration-");
  const file = join(directory, "norea.db");
  let db = new DatabaseSync(file);
  try {
    applyRegisteredMigrations(db, 0, 15);
    db.exec(`INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch,cursor,read_through,last_success_at)
      VALUES('https://state.example','["https://state.example","ws-1","epoch-1"]','ws-1','epoch-1',12,NULL,5000)`);

    applyRegisteredMigrations(db, 15, 16);
    db.close();
    db = new DatabaseSync(file);

    expect(
      db.prepare("SELECT workspace_id AS workspaceId, epoch, cursor, seed_suppressed AS seedSuppressed, seed_cutoff_at AS seedCutoffAt FROM user_state_workspace").get(),
    ).toEqual({
      workspaceId: "ws-1",
      epoch: "epoch-1",
      cursor: 12,
      seedSuppressed: 0,
      seedCutoffAt: null,
    });
    expect(() =>
      db.exec("UPDATE user_state_workspace SET seed_suppressed = 2 WHERE server_url = 'https://state.example'"),
    ).toThrow();
    expect(() =>
      db.exec("UPDATE user_state_workspace SET seed_cutoff_at = -1 WHERE server_url = 'https://state.example'"),
    ).toThrow();
    db.exec("UPDATE user_state_workspace SET seed_suppressed = 1, seed_cutoff_at = 1700000000000 WHERE server_url = 'https://state.example'");
    expect(
      db.prepare("SELECT seed_suppressed AS seedSuppressed, seed_cutoff_at AS seedCutoffAt FROM user_state_workspace").get(),
    ).toEqual({
      seedSuppressed: 1,
      seedCutoffAt: 1_700_000_000_000,
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

it("upgrades populated v16 storage to the single-progress model, normalizes unread=0 rows to 100, and strips unread from user-state JSON", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(".tmp/single-progress-migration-");
  const file = join(directory, "norea.db");
  let db = new DatabaseSync(file);
  try {
    applyRegisteredMigrations(db, 0, 16);
    db.exec(`INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library)
      VALUES(1,'source','work-1','/work','Work',1);
      INSERT INTO chapter(id,novel_id,path,name,position,progress,unread,read_at) VALUES
        (1,1,'/c1','Done partial',1,40,0,100),
        (2,1,'/c2','In progress',2,55,1,200),
        (3,1,'/c3','Unread zero',3,0,1,NULL),
        (4,1,'/c4','Already 100',4,100,0,300);
      INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread,read_at) VALUES
        ('source','/work','/old1',30,1,0,50),
        ('source','/work','/old2',60,0,1,60);
      INSERT INTO user_state_intent(entity_key,entity_json,value_json,seed)
      VALUES('["reading","k1"]','{"kind":"reading"}','{"progress":45,"unread":false,"readAt":100}',0),
            ('["reading","k2"]','{"kind":"reading"}','{"progress":45,"unread":true,"readAt":110}',0);
      INSERT INTO user_state_record(namespace,entity_key,revision,payload)
      VALUES('ns','["reading","k1"]',1,'{"entity":{"kind":"reading"},"value":{"progress":20,"unread":false,"readAt":90}}');
      INSERT INTO user_state_operation(operation_id,namespace,entity_key,intent_sequence,payload,status,receipt)
      VALUES('op-ack','ns','["reading","k1"]',1,'{"operationId":"op-ack","entity":{"kind":"reading"},"value":{"progress":45,"unread":false,"readAt":100}}','acknowledged','{"status":"applied","current":{"entity":{"kind":"reading"},"value":{"progress":45,"unread":false,"readAt":100}}}'),
            ('op-pend','ns','["reading","k2"]',2,'{"operationId":"op-pend","entity":{"kind":"reading"},"value":{"progress":45,"unread":true,"readAt":110}}','pending',NULL);
      INSERT INTO user_state_private(entity_key,public_value_json)
      VALUES('["reading","k1"]','{"progress":10,"unread":false,"readAt":80}');
      INSERT INTO content_sync_cache(cache_key,payload)
      VALUES('user-state-current:http://example','{}'),('keep-key','{}');`);

    applyRegisteredMigrations(db, 16, 17);
    db.close();
    db = new DatabaseSync(file);

    expect(db.prepare("PRAGMA table_info('chapter')").all().map((c) => c.name)).not.toContain("unread");
    expect(db.prepare("PRAGMA table_info('work_metadata_reading_state')").all().map((c) => c.name)).not.toContain("unread");
    expect(db.prepare("SELECT id, progress, read_at AS readAt FROM chapter ORDER BY id").all()).toEqual([
      { id: 1, progress: 100, readAt: 100 },
      { id: 2, progress: 55, readAt: 200 },
      { id: 3, progress: 0, readAt: null },
      { id: 4, progress: 100, readAt: 300 },
    ]);
    expect(db.prepare("SELECT chapter_path AS path, progress, bookmark, read_at AS readAt FROM work_metadata_reading_state ORDER BY chapter_path").all()).toEqual([
      { path: "/old1", progress: 100, bookmark: 1, readAt: 50 },
      { path: "/old2", progress: 60, bookmark: 0, readAt: 60 },
    ]);
    expect(db.prepare("SELECT entity_key AS key, value_json AS value FROM user_state_intent ORDER BY sequence").all()
      .map((r) => ({ key: r.key, value: JSON.parse(String(r.value)) }))).toEqual([
      { key: '["reading","k1"]', value: { progress: 100, readAt: 100 } },
      { key: '["reading","k2"]', value: { progress: 45, readAt: 110 } },
    ]);
    expect(JSON.parse(String((db.prepare("SELECT payload FROM user_state_record").get() as { payload: string }).payload)).value)
      .toEqual({ progress: 100, readAt: 90 });
    expect(db.prepare("SELECT operation_id FROM user_state_operation ORDER BY operation_id").all())
      .toEqual([{ operation_id: "op-ack" }]);
    const opRow = db.prepare("SELECT payload, receipt FROM user_state_operation WHERE operation_id='op-ack'").get() as { payload: string; receipt: string };
    expect(JSON.parse(opRow.payload).value).toEqual({ progress: 100, readAt: 100 });
    expect(JSON.parse(opRow.receipt).current.value).toEqual({ progress: 100, readAt: 100 });
    expect(JSON.parse(String((db.prepare("SELECT public_value_json FROM user_state_private").get() as { public_value_json: string }).public_value_json)))
      .toEqual({ progress: 100, readAt: 80 });
    expect(db.prepare("SELECT cache_key FROM content_sync_cache").all()).toEqual([{ cache_key: "keep-key" }]);
    expect(db.prepare("SELECT total_chapters AS total, chapters_unread AS unread FROM novel_stats WHERE novel_id=1").get())
      .toEqual({ total: 4, unread: 2 });
    db.exec("UPDATE chapter SET progress=100 WHERE id=2");
    expect(db.prepare("SELECT chapters_unread AS unread FROM novel_stats WHERE novel_id=1").get())
      .toEqual({ unread: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='chapter_progress_found_position_idx'").get())
      .toEqual({ name: "chapter_progress_found_position_idx" });
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

it("upgrades populated v17 storage to index pending user_state_operation entity lookups without altering rows", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(".tmp/user-state-op-entity-index-migration-");
  const file = join(directory, "norea.db");
  let db = new DatabaseSync(file);
  try {
    applyRegisteredMigrations(db, 0, 17);
    db.exec(`INSERT INTO user_state_operation(operation_id,namespace,entity_key,intent_sequence,payload,status,receipt,acknowledged_at) VALUES
      ('op-pending','ns','["reading","k1"]',1,'{}','pending',NULL,NULL),
      ('op-ack','ns','["reading","k2"]',2,'{}','acknowledged','{}',100)`);
    const before = db.prepare("SELECT * FROM user_state_operation ORDER BY intent_sequence").all();

    applyRegisteredMigrations(db, 17, 18);
    db.close();
    db = new DatabaseSync(file);

    expect(db.prepare("SELECT * FROM user_state_operation ORDER BY intent_sequence").all()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='user_state_operation_pending_entity_idx'").get())
      .toEqual({ name: "user_state_operation_pending_entity_idx" });
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM user_state_operation WHERE namespace = 'ns' AND status = 'pending' AND entity_key = '[\"reading\",\"k1\"]'",
    ).all() as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("user_state_operation_pending_entity_idx"))).toBe(true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

it("upgrades populated v18 storage to cache chapter payload digests and clear them when emptied or deleted", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(".tmp/chapter-payload-digest-migration-");
  const file = join(directory, "norea.db");
  let db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    applyRegisteredMigrations(db, 0, 18);
    db.exec(`INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library)
      VALUES(1,'source','work-1','/work','Work',1);
      INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,content_bytes) VALUES
        (1,1,'/c1','One',1,1,120),
        (2,1,'/c2','Two',2,1,240)`);
    const before = db.prepare("SELECT * FROM chapter ORDER BY id").all();

    applyRegisteredMigrations(db, 18, 19);
    db.close();
    db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=ON");

    expect(db.prepare("SELECT * FROM chapter ORDER BY id").all()).toEqual(before);
    db.exec(`INSERT INTO chapter_payload_digest(chapter_id,storage_dir,storage_signature,body_sha256,body_bytes,payload_hash)
      VALUES
        (1,'contents/source/work-1/1','sig1','${"a".repeat(64)}',120,'${"b".repeat(64)}'),
        (2,'contents/source/work-1/2','sig2','${"c".repeat(64)}',240,'${"d".repeat(64)}')`);
    expect(() => db.exec(
      `INSERT INTO chapter_payload_digest(chapter_id,storage_dir,storage_signature,body_sha256,body_bytes,payload_hash)
       VALUES(1,'contents/source/work-1/1','sig','${"a".repeat(64)}',-1,'${"b".repeat(64)}')`,
    )).toThrow();
    // Clearing chapter content triggers automatic digest invalidation.
    db.exec("UPDATE chapter SET content_bytes=0, is_downloaded=0 WHERE id=1");
    expect(db.prepare("SELECT chapter_id FROM chapter_payload_digest ORDER BY chapter_id").all())
      .toEqual([{ chapter_id: 2 }]);
    // Deleting the chapter cascades digest deletion.
    db.exec("DELETE FROM chapter WHERE id=2");
    expect(db.prepare("SELECT chapter_id FROM chapter_payload_digest").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});
