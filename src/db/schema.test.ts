import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";
import * as schema from "./schema";

it("creates every current Drizzle table and column from the single v1 bootstrap", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
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
