import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("executes both native lease queries without exposing VPN-enrolled jobs to ordinary restoration", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
    const insert = db.prepare("INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?)");
    for (const [id, ownership] of [
      [1, { vpnPlanId: "plan", vpnRangeId: "range" }],
      [2, { vpnPlanId: "plan" }],
      [3, { vpnRangeId: "range" }],
      [4, {}],
      [5, { vpnPlanId: null, vpnRangeId: null }],
    ] as const) {
      insert.run(id, JSON.stringify({ id, pluginId: "source", chapterPath: `/${id}`, title: "Chapter", ...ownership }), id, id);
    }
    const nativeSource = readFileSync("src-tauri/src/download_queue.rs", "utf8");
    const leaseQueries = [...nativeSource.matchAll(/r#"([\s\S]*?)"#/g)]
      .map(match => match[1]!).filter(sql => /SELECT\s+chapter_id,\s*job_json/.test(sql));
    expect(leaseQueries.length).toBeGreaterThan(0);
    for (const sql of leaseQueries) {
      const rows = /LIMIT\s+\?1/.test(sql) ? db.prepare(sql).all(1) : db.prepare(sql).all();
      expect(rows.map(row => row.chapter_id)).toEqual(/LIMIT\s+\?1/.test(sql) ? [4] : [4, 5]);
    }
  } finally { db.close(); }
});
