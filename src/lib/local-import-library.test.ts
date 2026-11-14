import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ getDb: vi.fn(), transaction: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: client.invoke }));
vi.mock("../db/client", () => ({ getDb: client.getDb, runDatabaseTransaction: client.transaction }));
vi.mock("../db/queries/novel-identity", () => ({ reconcileImportedNovelIdentityInDb: vi.fn(async () => null), findMatchingNovelIdentityInDb: vi.fn(async () => null) }));
vi.mock("./local-import-media", () => ({ cacheLocalImportedChapterMedia: vi.fn() }));
import { importLocalFileToLibrary } from "./local-import-library";
import { importSystemOpenedFile } from "./system-file-import";
import { cacheLocalImportedChapterMedia } from "./local-import-media";

let sqlite: DatabaseSync;
let queue: Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  const bind = (params: unknown[]) => Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value]));
  const db = {
    select: async (query: string, params: unknown[] = []) => sqlite.prepare(query).all(bind(params) as never),
    execute: async (query: string, params: unknown[] = []) => {
      const result = sqlite.prepare(query).run(bind(params) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
  queue = Promise.resolve();
  client.getDb.mockResolvedValue(db);
  client.transaction.mockImplementation((run: (db: Database) => Promise<unknown>) => {
    const result = queue.then(async () => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const value = await run(db); sqlite.exec("COMMIT"); return value; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    });
    queue = result.catch(() => undefined);
    return result;
  });
  client.invoke.mockImplementation((command: string, args: {
    input?: {
      path: string;
      name: string;
      cover: string | null;
      hasCover: boolean;
      summary: string | null;
      hasSummary: boolean;
      author: string | null;
      hasAuthor: boolean;
      artist: string | null;
      hasArtist: boolean;
      status: string | null;
      hasStatus: boolean;
      genres: string | null;
      hasGenres: boolean;
      chapters: Array<{
        path: string;
        name: string;
        position: number;
        contentType: string;
        contentBytes: number;
        chapterNumber: string | null;
        page: string | null;
        releaseTime: string | null;
      }>;
    };
  } = {}) => {
    if (command !== "db_novel_upsert_local") {
      throw new Error(`Unexpected command: ${command}`);
    }
    const input = args.input!;
    return client.transaction(async (txDb: Database) => {
      const [current] = input.path === "local"
        ? await txDb.select<Array<{
            cover: string | null;
            summary: string | null;
            author: string | null;
            artist: string | null;
            status: string | null;
            genres: string | null;
          }>>(
            "SELECT cover,summary,author,artist,status,genres FROM novel WHERE plugin_id=$1 AND path=$2",
            ["local", "local"],
          )
        : [];
      const novelRes = await txDb.execute(
        `INSERT INTO novel
             (plugin_id, path, name, cover, summary, author, artist, status, genres, in_library, is_local, library_added_at, source_novel_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, unixepoch(), $2)
           ON CONFLICT(plugin_id, path) DO UPDATE SET
             name = excluded.name,
             source_novel_id = excluded.source_novel_id,
             cover = excluded.cover,
             summary = excluded.summary,
             author = excluded.author,
             artist = excluded.artist,
             status = excluded.status,
             genres = excluded.genres,
             in_library = 1,
             is_local = 1,
             library_added_at = COALESCE(library_added_at, unixepoch()),
             updated_at = unixepoch()`,
        [
          "local",
          input.path,
          input.name,
          input.hasCover ? input.cover : current?.cover ?? null,
          input.hasSummary ? input.summary : current?.summary ?? null,
          input.hasAuthor ? input.author : current?.author ?? null,
          input.hasArtist ? input.artist : current?.artist ?? null,
          input.hasStatus ? input.status : current?.status ?? null,
          input.hasGenres ? input.genres : current?.genres ?? null,
        ],
      );
      const [{ id: novelId }] = await txDb.select<Array<{ id: number }>>(
        "SELECT id FROM novel WHERE plugin_id = $1 AND path = $2",
        ["local", input.path],
      );
      let chapters = input.chapters;
      if (input.path === "local" && chapters.length > 0) {
        const existing = await txDb.select<Array<{ path: string; position: number; chapterNumber: string | null }>>(
          "SELECT path, position, chapter_number AS chapterNumber FROM chapter WHERE novel_id = $1",
          [novelId],
        );
        const byPath = new Map(existing.map(c => [c.path, c]));
        let lastPosition = existing.reduce((max, c) => Math.max(max, c.position), 0);
        chapters = chapters.map(c => {
          const prev = byPath.get(c.path);
          const pos = prev?.position ?? ++lastPosition;
          return { ...c, position: pos, chapterNumber: prev?.chapterNumber ?? String(pos) };
        });
      }
      let changedChapters = 0;
      for (const ch of chapters) {
        const storedType = ch.contentType === "pdf" ? "pdf" : ch.contentType === "markdown" ? "markdown" : "html";
        const r = await txDb.execute(
          `INSERT INTO chapter
             (novel_id, path, name, position, chapter_number, page, release_time, content_type, stored_content_type, content_bytes, media_repair_needed, is_downloaded)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 1)
           ON CONFLICT(novel_id, path) DO UPDATE SET
             name = excluded.name,
             position = excluded.position,
             chapter_number = excluded.chapter_number,
             page = excluded.page,
             release_time = excluded.release_time,
             content_type = excluded.content_type,
             stored_content_type = excluded.stored_content_type,
             content_bytes = excluded.content_bytes,
             media_repair_needed = 0,
             is_downloaded = 1,
             updated_at = unixepoch()`,
          [
            novelId,
            ch.path,
            ch.name,
            ch.position,
            ch.chapterNumber,
            ch.page ?? "1",
            ch.releaseTime,
            ch.contentType,
            storedType,
            ch.contentBytes,
          ],
        );
        changedChapters += r.rowsAffected;
      }
      return {
        value: {
          changed: novelRes.rowsAffected > 0 || changedChapters > 0,
          changedChapters,
          novelId,
          chapterCount: input.chapters.length,
        },
        effects: {},
      };
    });
  });
});
afterEach(() => sqlite.close());

it("puts files from library and system open in one local work and selects the opened file", async () => {
  await importLocalFileToLibrary(new File(["First body"], "First.txt"));
  const opened = await importSystemOpenedFile(new File(["# Second body"], "Second.md"));
  expect(sqlite.prepare("SELECT plugin_id,path,name FROM novel").all()).toEqual([{ plugin_id: "local", path: "local", name: "local" }]);
  const chapters = sqlite.prepare("SELECT id,novel_id,name,position,chapter_number FROM chapter ORDER BY position").all();
  expect(chapters).toEqual([
    { id: expect.any(Number), novel_id: opened.novelId, name: "First", position: 1, chapter_number: "1" },
    { id: opened.chapterId, novel_id: opened.novelId, name: "Second", position: 2, chapter_number: "2" },
  ]);
  expect(cacheLocalImportedChapterMedia).toHaveBeenLastCalledWith(expect.objectContaining({ novelName: "local", sourceNovelId: "local" }));
});

it("reopens the same file without duplicating it, changing its order or resetting reading state", async () => {
  const first = await importSystemOpenedFile(new File(["First body"], "First.txt"));
  await importSystemOpenedFile(new File(["Second body"], "Second.txt"));
  sqlite.prepare("UPDATE chapter SET progress=43,bookmark=1,unread=0,read_at=123 WHERE id=?").run(first.chapterId);
  expect(await importSystemOpenedFile(new File(["First body"], "First.txt"))).toEqual(first);
  expect(sqlite.prepare("SELECT COUNT(*) AS total FROM chapter").get()).toEqual({ total: 2 });
  expect(sqlite.prepare("SELECT position,chapter_number,progress,bookmark,unread,read_at FROM chapter WHERE id=?").get(first.chapterId)).toEqual({ position: 1, chapter_number: "1", progress: 43, bookmark: 1, unread: 0, read_at: 123 });
});

it("allocates distinct positions when two entry points import together", async () => {
  const results = await Promise.all([
    importSystemOpenedFile(new File(["First body"], "First.txt")),
    importSystemOpenedFile(new File(["Second body"], "Second.md")),
  ]);
  expect(results[0].novelId).toBe(results[1].novelId);
  expect(results[0].chapterId).not.toBe(results[1].chapterId);
  expect(sqlite.prepare("SELECT position FROM chapter ORDER BY position").all()).toEqual([{ position: 1 }, { position: 2 }]);
});

it("keeps local home metadata when another file is added", async () => {
  const first = await importSystemOpenedFile(new File(["First body"], "First.txt"));
  sqlite.prepare("UPDATE novel SET summary='My local files',author='Owner' WHERE id=?").run(first.novelId);
  await importLocalFileToLibrary(new File(["Another body"], "Another.txt"));
  expect(sqlite.prepare("SELECT name,summary,author FROM novel WHERE id=?").get(first.novelId)).toEqual({ name: "local", summary: "My local files", author: "Owner" });
});
