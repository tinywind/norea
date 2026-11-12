import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  runDatabaseTransaction: vi.fn(),
}));

import { runDatabaseTransaction } from "../client";
import { applyNovelMergeInDb } from "./novel-merge";

const mockedRunDatabaseTransaction = vi.mocked(runDatabaseTransaction);
let mockExecute: ReturnType<typeof vi.fn>;
let mockSelect: ReturnType<typeof vi.fn>;

const sourceNovel = {
  id: 1,
  pluginId: "source-a",
  inLibrary: 1,
  isLocal: 0,
  libraryAddedAt: 10,
  lastReadAt: 40,
};

const targetNovel = {
  id: 2,
  pluginId: "source-b",
  inLibrary: 0,
  isLocal: 0,
  libraryAddedAt: null,
  lastReadAt: 30,
};

function sourceChapter(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    novelId: 1,
    path: "/a/1",
    bookmark: 1,
    unread: 0,
    progress: 70,
    isDownloaded: 1,
    sourceContentType: "html",
    contentType: "html",
    contentBytes: 120,
    mediaBytes: 30,
    mediaRepairNeeded: 0,
    mediaBytesCheckedAt: 50,
    readAt: 40,
    ...overrides,
  };
}

function targetChapter(overrides: Record<string, unknown> = {}) {
  return {
    id: 21,
    novelId: 2,
    path: "/b/1",
    bookmark: 0,
    unread: 1,
    progress: 20,
    isDownloaded: 0,
    sourceContentType: "pdf",
    contentType: "pdf",
    contentBytes: 0,
    mediaBytes: 0,
    mediaRepairNeeded: 0,
    mediaBytesCheckedAt: null,
    readAt: 30,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  mockSelect = vi
    .fn()
    .mockResolvedValueOnce([sourceNovel, targetNovel])
    .mockResolvedValueOnce([sourceChapter(), targetChapter()]);
  mockedRunDatabaseTransaction.mockImplementation(async (run) =>
    run({ execute: mockExecute, select: mockSelect } as never),
  );
});

describe("applyNovelMergeInDb", () => {
  it("keeps B identity while merging mapped A state and prepared content", async () => {
    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      preparedDownloads: [
        {
          sourceChapterId: 11,
          contentType: "html",
          contentBytes: 125,
          mediaBytes: 35,
          transferredFromSource: true,
        },
      ],
    });

    expect(result).toEqual({
      targetNovelId: 2,
      chapterIdMap: { 11: 21 },
      preferredLastReadChapterId: 21,
      transferredDownloads: 1,
    });

    const statements = mockExecute.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("DELETE FROM chapter_download_queue"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT OR IGNORE INTO novel_category"))).toBe(true);

    const targetUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("stored_content_type"),
    );
    expect(String(targetUpdateCall?.[0])).not.toMatch(/\n\s*content_type\s*=/);
    expect(targetUpdateCall?.[1]).toEqual([
      21,
      1,
      0,
      70,
      40,
      1,
      "html",
      125,
      35,
      1,
    ]);

    const deleteSourceCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM novel"),
    );
    expect(deleteSourceCall?.[1]).toEqual([1]);
  });

  it("leaves an existing B download unchanged when native storage kept it", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter(),
        targetChapter({
          isDownloaded: 1,
          contentType: "pdf",
          contentBytes: 900,
        }),
      ]);

    await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      preparedDownloads: [],
    });

    const targetUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("stored_content_type"),
    );
    expect(targetUpdateCall?.[1]?.[5]).toBe(0);
    expect(targetUpdateCall?.[1]?.[6]).toBeNull();
  });

  it("adopts retained B metadata when its download flag was stale", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter({ isDownloaded: 0 }),
        targetChapter(),
      ]);

    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      preparedDownloads: [
        {
          sourceChapterId: 11,
          contentType: "pdf",
          contentBytes: 900,
          mediaBytes: 0,
          transferredFromSource: false,
        },
      ],
    });

    const targetUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("stored_content_type"),
    );
    expect(targetUpdateCall?.[1]?.slice(5, 9)).toEqual([1, "pdf", 900, 0]);
    expect(result.transferredDownloads).toBe(0);
  });

  it("adopts copied A metadata when the B download flag was stale", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter(),
        targetChapter({
          isDownloaded: 1,
          contentType: "pdf",
          contentBytes: 900,
        }),
      ]);

    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      preparedDownloads: [
        {
          sourceChapterId: 11,
          contentType: "html",
          contentBytes: 125,
          mediaBytes: 35,
          transferredFromSource: true,
        },
      ],
    });

    const targetUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("stored_content_type"),
    );
    expect(targetUpdateCall?.[1]?.[5]).toBe(1);
    expect(targetUpdateCall?.[1]?.[6]).toBe("html");
    expect(result.transferredDownloads).toBe(1);
  });

  it("updates multiple mapped B chapters in one bulk statement", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter(),
        sourceChapter({ id: 12, path: "/a/2" }),
        targetChapter(),
        targetChapter({ id: 22, path: "/b/2" }),
      ]);

    await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        { sourceChapterId: 12, kind: "map", targetChapterPath: "/b/2" },
      ],
      preparedDownloads: [],
    });

    const chapterUpdateCalls = mockExecute.mock.calls.filter(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("merge_updates"),
    );
    expect(chapterUpdateCalls).toHaveLength(1);
    expect(chapterUpdateCalls[0]?.[1]).toHaveLength(20);
  });

  it("requires an explicit decision for every A chapter", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter(),
        sourceChapter({ id: 12, path: "/a/greeting" }),
        targetChapter(),
      ]);

    await expect(
      applyNovelMergeInDb({
        sourceNovelId: 1,
        targetNovelId: 2,
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        ],
        preparedDownloads: [],
      }),
    ).rejects.toThrow("Every source chapter must have one decision");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("rejects a mapping to a chapter that does not belong to B", async () => {
    await expect(
      applyNovelMergeInDb({
        sourceNovelId: 1,
        targetNovelId: 2,
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/missing" },
        ],
        preparedDownloads: [],
      }),
    ).rejects.toThrow("Target chapter no longer exists");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("allows an A-only author note to be explicitly excluded", async () => {
    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [{ sourceChapterId: 11, kind: "exclude" }],
      preparedDownloads: [],
    });

    expect(result.chapterIdMap).toEqual({});
    expect(result.transferredDownloads).toBe(0);
    const novelUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE novel"),
    );
    expect(novelUpdateCall?.[1]?.[3]).toBe(30);
    expect(
      mockExecute.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM novel")),
    ).toBe(true);
  });

  it("rejects local novels but accepts different works under the same source plugin", async () => {
    mockSelect.mockReset().mockResolvedValueOnce([
      { ...sourceNovel, isLocal: 1 },
      targetNovel,
    ]);
    await expect(
      applyNovelMergeInDb({
        sourceNovelId: 1,
        targetNovelId: 2,
        decisions: [{ sourceChapterId: 11, kind: "exclude" }],
        preparedDownloads: [],
      }),
    ).rejects.toThrow("remote novels only");

    mockSelect.mockReset()
      .mockResolvedValueOnce([sourceNovel, { ...targetNovel, pluginId: sourceNovel.pluginId }])
      .mockResolvedValueOnce([sourceChapter(), targetChapter()]);
    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [{ sourceChapterId: 11, kind: "exclude" }],
      preparedDownloads: [],
    });
    expect(result.targetNovelId).toBe(2);
    expect(mockExecute.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM novel"))).toBe(true);
  });
});


describe("applyNovelMergeInDb user state transaction", () => {
  let sqlite: DatabaseSync;
  const params = (values: unknown[]) => Object.fromEntries(
    values.map((value, index) => ["$" + (index + 1), value]),
  ) as never;
  const input = () => ({
    sourceNovelId: 1,
    targetNovelId: 2,
    decisions: [
      { sourceChapterId: 11, kind: "map" as const, targetChapterPath: "/b/1" },
      { sourceChapterId: 12, kind: "map" as const, targetChapterPath: "/b/2" },
      { sourceChapterId: 13, kind: "exclude" as const },
    ],
    preparedDownloads: [],
  });

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const registration = readFileSync("src-tauri/src/database.rs", "utf8");
    for (const match of registration.matchAll(/include_str!\("([^"]+)"\)/g)) {
      sqlite.exec(readFileSync("src-tauri/src/" + match[1], "utf8"));
    }
    sqlite.exec("INSERT INTO novel(id,plugin_id,path,name,in_library,library_added_at) VALUES(1,'source-a','/a','Source',1,10),(2,'source-b','/b','Target',0,NULL)");
    sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(11,1,'/a/1','1화',1),(12,1,'/a/2','2화',2),(13,1,'/a/note','Note',3),(21,2,'/b/1','1화',1),(22,2,'/b/2','2화',2)");
    sqlite.exec("UPDATE chapter SET unread=0,progress=100,bookmark=1,read_at=40 WHERE id=11");
    sqlite.exec("UPDATE chapter SET progress=11,read_at=50 WHERE id=12");
    sqlite.exec("UPDATE chapter SET progress=20,read_at=30 WHERE id=21");
    sqlite.exec("UPDATE novel SET source_novel_id=CASE id WHEN 1 THEN '101' ELSE '202' END");
    sqlite.exec("UPDATE chapter SET chapter_number=CASE WHEN novel_id=1 THEN CAST(id-10 AS TEXT) ELSE CAST(id+5980 AS TEXT) END");
    const db = {
      select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql).all(params(values)),
      execute: async (sql: string, values: unknown[] = []) => ({
        rowsAffected: Number(sqlite.prepare(sql).run(params(values)).changes),
        lastInsertId: 0,
      }),
    };
    mockedRunDatabaseTransaction.mockImplementation(async (run) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await run(db as never);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    });
  });

  afterEach(() => { sqlite.close(); });

  it("commits the folder move journal atomically with source retirement", async () => {
    sqlite.exec(`INSERT INTO content_sync_cache VALUES('norea-novel-merge-storage:move-1','{"phase":"preparing"}')`);
    await applyNovelMergeInDb({ ...input(), storageTransferToken: "move-1" });
    expect(sqlite.prepare("SELECT json_extract(payload,'$.phase') AS phase FROM content_sync_cache WHERE cache_key='norea-novel-merge-storage:move-1'").get())
      .toEqual({ phase: "committed" });
  });

  it("rolls the folder move journal back with a rejected source deletion", async () => {
    sqlite.exec(`INSERT INTO content_sync_cache VALUES('norea-novel-merge-storage:move-1','{"phase":"preparing"}');
      CREATE TRIGGER reject_move BEFORE DELETE ON novel WHEN OLD.id=1 BEGIN SELECT RAISE(ABORT,'source busy'); END;`);
    await expect(applyNovelMergeInDb({ ...input(), storageTransferToken: "move-1" })).rejects.toThrow("source busy");
    expect(sqlite.prepare("SELECT json_extract(payload,'$.phase') AS phase FROM content_sync_cache WHERE cache_key='norea-novel-merge-storage:move-1'").get())
      .toEqual({ phase: "preparing" });
  });

  it.each([
    ["entire", null],
    ["all_remaining", null],
    ["keep_ahead", 7],
    ["none", null],
  ])("retains an A %s policy when B follows the default", async (kind, count) => {
    sqlite.prepare("INSERT INTO novel_download_goal(novel_id,kind,count,updated_at) VALUES(1,?,?,10)").run(kind, count);
    await applyNovelMergeInDb(input());
    expect(sqlite.prepare("SELECT * FROM novel_download_goal").all()).toEqual([
      { novel_id: 2, kind, count, updated_at: 10 },
    ]);
  });

  it.each([
    ["none", null],
    ["keep_ahead", 3],
    ["entire", null],
  ])("retains B's explicit %s policy over A's entire goal", async (kind, count) => {
    sqlite.exec("INSERT INTO novel_download_goal(novel_id,kind,count,updated_at) VALUES(1,'entire',NULL,10)");
    sqlite.prepare("INSERT INTO novel_download_goal(novel_id,kind,count,updated_at) VALUES(2,?,?,20)").run(kind, count);
    await applyNovelMergeInDb(input());
    expect(sqlite.prepare("SELECT * FROM novel_download_goal").all()).toEqual([
      { novel_id: 2, kind, count, updated_at: 20 },
    ]);
  });

  it("leaves the default policy in place when neither work has a goal", async () => {
    await applyNovelMergeInDb(input());
    expect(sqlite.prepare("SELECT * FROM novel_download_goal").all()).toEqual([]);
  });

  it("unions mapped exclusions with B and drops only explicitly excluded A chapters", async () => {
    sqlite.exec("INSERT INTO chapter_download_goal_exclusion(chapter_id,created_at) VALUES(11,5),(12,6),(13,7),(22,9)");
    await applyNovelMergeInDb(input());
    expect(sqlite.prepare("SELECT * FROM chapter_download_goal_exclusion ORDER BY chapter_id").all()).toEqual([
      { chapter_id: 21, created_at: 5 },
      { chapter_id: 22, created_at: 9 },
    ]);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains one exclusion when several A chapters map to the same B chapter", async () => {
    sqlite.exec("INSERT INTO chapter_download_goal_exclusion(chapter_id,created_at) VALUES(11,10),(12,5)");
    const merge = input();
    merge.decisions[1] = { sourceChapterId: 12, kind: "map", targetChapterPath: "/b/1" };
    await applyNovelMergeInDb(merge);
    expect(sqlite.prepare("SELECT * FROM chapter_download_goal_exclusion").all()).toEqual([
      { chapter_id: 21, created_at: 5 },
    ]);
  });

  it("preserves read completion, partial progress, bookmarks and B identity", async () => {
    const result = await applyNovelMergeInDb(input());
    expect(result.chapterIdMap).toEqual({ 11: 21, 12: 22 });
    expect(result.preferredLastReadChapterId).toBe(22);
    expect(sqlite.prepare("SELECT id,novel_id,path,name,unread,progress,bookmark,read_at FROM chapter ORDER BY id").all()).toEqual([
      { id: 21, novel_id: 2, path: "/b/1", name: "1화", unread: 0, progress: 100, bookmark: 1, read_at: 40 },
      { id: 22, novel_id: 2, path: "/b/2", name: "2화", unread: 1, progress: 11, bookmark: 0, read_at: 50 },
    ]);
    expect(sqlite.prepare("SELECT id,plugin_id,path,in_library,library_added_at,last_read_at FROM novel").all()).toEqual([
      { id: 2, plugin_id: "source-b", path: "/b", in_library: 1, library_added_at: 10, last_read_at: 50 },
    ]);
  });

  it.each([0, 4.5])("does not fill freshly absent B metadata from A, including a rating of %s", async rating => {
    sqlite.prepare("UPDATE novel SET author=?,artist=?,summary=?,status=?,genres=?,rating=? WHERE id=1")
      .run("Source Author", "Source Artist", "First paragraph.\nSecond paragraph.", "Completed", "Fantasy", rating);
    sqlite.exec("UPDATE novel SET author=NULL,artist=NULL,summary=NULL,status=NULL,genres=NULL,rating=NULL WHERE id=2");

    await applyNovelMergeInDb(input());

    expect(sqlite.prepare("SELECT id,plugin_id,source_novel_id,path,name,author,artist,summary,status,genres,rating FROM novel").all()).toEqual([{
      id: 2, plugin_id: "source-b", source_novel_id: "202", path: "/b", name: "Target",
      author: null, artist: null, summary: null, status: null, genres: null, rating: null,
    }]);
  });

  it("keeps the freshly parsed B details and cover URL independent of A", async () => {
    sqlite.prepare("UPDATE novel SET author=?,artist=?,summary=?,status=?,genres=?,rating=?,cover=? WHERE id=1")
      .run("Source Author", "Source Artist", "Source Summary", "Completed", "Fantasy", 4.5, "https://source-a.test/cover.jpg");
    sqlite.prepare("UPDATE novel SET author=?,artist=?,summary=?,status=?,genres=?,rating=?,cover=? WHERE id=2")
      .run("Target Author", "Target Artist", " Target Summary ", "Ongoing", "Adventure", 0, "https://source-b.test/cover.png");

    await applyNovelMergeInDb(input());

    expect(sqlite.prepare("SELECT author,artist,summary,status,genres,rating,cover FROM novel WHERE id=2").get()).toEqual({
      author: "Target Author", artist: "Target Artist", summary: " Target Summary ",
      status: "Ongoing", genres: "Adventure", rating: 0, cover: "https://source-b.test/cover.png",
    });
  });

  it("leaves unknown fields empty when neither work has metadata", async () => {
    sqlite.prepare("UPDATE novel SET author='',artist=NULL,summary=?,status=' ',genres='',rating=NULL WHERE id=1")
      .run("\n\t");

    await applyNovelMergeInDb(input());

    expect(sqlite.prepare("SELECT author,artist,summary,status,genres,rating FROM novel WHERE id=2").get()).toEqual({
      author: null, artist: null, summary: null, status: null, genres: null, rating: null,
    });
  });

  it("records the server migration identity and mapping in the same commit that removes A", async () => {
    sqlite.exec("UPDATE chapter SET is_downloaded=1,content_bytes=100 WHERE id=11");
    await applyNovelMergeInDb({
      ...input(),
      contentSyncServerUrl: "https://content.example.test/",
      contentSyncSourceSnapshot: {
        work: { id: "source-work", revision: "source-v1", identity: { pluginId: "source-a", novelId: "101", novelPath: "/a" } },
        chapters: [
          { id: "source-chapter", revision: "chapter-v1", chapterPath: "/a/1", chapterNumber: "1", complete: true, available: true },
        ],
      },
      preparedDownloads: [
        { sourceChapterId: 11, contentType: "html", contentBytes: 100, mediaBytes: 0, transferredFromSource: true },
      ],
    });

    const jobs = sqlite.prepare("SELECT payload FROM content_sync_cache WHERE cache_key LIKE 'norea-content-novel-migration:%'").all() as { payload: string }[];
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.payload)).toMatchObject({
      version: 1,
      serverUrl: "https://content.example.test",
      status: "pending",
      source: { pluginId: "source-a", novelId: "101", novelPath: "/a" },
      target: { pluginId: "source-b", novelId: "202", novelPath: "/b" },
      targetLocalNovelId: 2,
      chapters: [
        { sourceChapterPath: "/a/1", sourceChapterNumber: "1", targetChapterPath: "/b/1", targetChapterNumber: "6001", decision: "copy-source" },
        { sourceChapterPath: "/a/2", sourceChapterNumber: "2", targetChapterPath: "/b/2", targetChapterNumber: "6002", decision: "copy-source" },
        { sourceChapterPath: "/a/note", sourceChapterNumber: "3", targetChapterPath: null, targetChapterNumber: null, decision: null },
      ],
    });
    expect(sqlite.prepare("SELECT id FROM novel ORDER BY id").all()).toEqual([{ id: 2 }]);
  });

  it("rolls back metadata, the server job, goal, exclusions and reading state if source deletion fails", async () => {
    sqlite.exec("UPDATE novel SET author='Source Author',summary='Source Summary',rating=4.5 WHERE id=1");
    sqlite.exec("INSERT INTO novel_download_goal(novel_id,kind,count,updated_at) VALUES(1,'entire',NULL,10)");
    sqlite.exec("INSERT INTO chapter_download_goal_exclusion(chapter_id,created_at) VALUES(11,5),(12,6),(13,7)");
    sqlite.exec("CREATE TRIGGER reject_source_merge BEFORE DELETE ON novel WHEN OLD.id=1 BEGIN SELECT RAISE(ABORT,'source deletion rejected'); END");
    const snapshot = () => ({
      novels: sqlite.prepare("SELECT * FROM novel ORDER BY id").all(),
      chapters: sqlite.prepare("SELECT * FROM chapter ORDER BY id").all(),
      goals: sqlite.prepare("SELECT * FROM novel_download_goal ORDER BY novel_id").all(),
      exclusions: sqlite.prepare("SELECT * FROM chapter_download_goal_exclusion ORDER BY chapter_id").all(),
      syncCache: sqlite.prepare("SELECT * FROM content_sync_cache ORDER BY cache_key").all(),
    });
    const before = snapshot();

    await expect(applyNovelMergeInDb({
      ...input(),
      contentSyncServerUrl: "https://content.example.test",
    })).rejects.toThrow("source deletion rejected");

    expect(snapshot()).toEqual(before);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("records a recipient receipt in the same transaction as local reading-state migration", async () => {
    await applyNovelMergeInDb({ ...input(), recordIncomingMigration: async db => {
      expect(sqlite.prepare("SELECT id FROM novel WHERE id=1").get()).toEqual({ id: 1 });
      await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2)", ["norea-content-incoming-migration:receipt", JSON.stringify({ status: "completed" })]);
    } });
    expect(sqlite.prepare("SELECT id FROM novel ORDER BY id").all()).toEqual([{ id: 2 }]);
    expect(sqlite.prepare("SELECT unread,progress,bookmark FROM chapter WHERE id=21").get()).toEqual({ unread: 0, progress: 100, bookmark: 1 });
    expect(sqlite.prepare("SELECT cache_key FROM content_sync_cache").all()).toEqual([{ cache_key: "norea-content-incoming-migration:receipt" }]);
  });
  it("rolls recipient receipt and reading state back when the source cannot be removed", async () => {
    sqlite.exec("CREATE TRIGGER reject_incoming_merge BEFORE DELETE ON novel WHEN OLD.id=1 BEGIN SELECT RAISE(ABORT,'incoming deletion rejected'); END");
    const before = sqlite.prepare("SELECT * FROM chapter ORDER BY id").all();
    await expect(applyNovelMergeInDb({ ...input(), recordIncomingMigration: async db => {
      await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2)", ["norea-content-incoming-migration:receipt", JSON.stringify({ status: "completed" })]);
    } })).rejects.toThrow("incoming deletion rejected");
    expect(sqlite.prepare("SELECT id FROM novel ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(sqlite.prepare("SELECT * FROM chapter ORDER BY id").all()).toEqual(before);
    expect(sqlite.prepare("SELECT * FROM content_sync_cache").all()).toEqual([]);
  });

});
