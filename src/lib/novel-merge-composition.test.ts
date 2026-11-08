import { describe, expect, it } from "vitest";
import type { ChapterListRow } from "../db/queries/chapter";
import type { NovelDetailRecord } from "../db/queries/novel";
import { compileNovelMergeComposition, validateNovelMergeComposition, type NovelMergeCompositionEntry } from "./novel-merge-composition";
import { compositionSourceAnchor, refreshChapterComposition } from "./chapter-composition-refresh";
import { includedChapterCompositionEntries, parseChapterComposition } from "./chapter-composition";

const a = { id: 1, pluginId: "source-a", sourceNovelId: "work-a", path: "/a" } as NovelDetailRecord;
const b = { id: 2, pluginId: "source-b", sourceNovelId: "work-b", path: "/b" } as NovelDetailRecord;
function chapter(side: "a" | "b", number: number, downloaded = false): ChapterListRow {
  return { id: (side === "a" ? 10_000 : 20_000) + number, novelId: side === "a" ? 1 : 2,
    path: `/${side}/${number}`, name: `${side} chapter ${number}`, chapterNumber: String(number), position: number,
    page: "1", bookmark: false, unread: true, progress: 0, isDownloaded: downloaded,
    sourceContentType: "html", contentType: "html", contentBytes: downloaded ? 120 : 0, mediaBytes: 0,
    mediaRepairNeeded: false, releaseTime: null, readAt: null, createdAt: null, foundAt: 0, updatedAt: 0 };
}
function compile(entries: NovelMergeCompositionEntry[], source = [chapter("a", 1, true), chapter("a", 2), chapter("a", 3)], target = [chapter("b", 1), chapter("b", 2), chapter("b", 3)]) {
  let id = 0;
  return compileNovelMergeComposition({ entries, sourceNovel: a, targetNovel: b, sourceChapters: source, targetChapters: target,
    now: 100, newId: () => `entry-${++id}` });
}

describe("compiled chapter compositions", () => {
  it("preserves an already-composed A user title when its original source title differs", () => {
    const original = chapter("a", 1, true);
    const old = { version: 1 as const, updatedAt: 200, entries: [{ id: "old-a", path: "norea-composed:old-a", storageChapterNumber: "40",
      sources: [{ pluginId: "source-a", novelId: "work-a", novelPath: "/a", chapterPath: "/a/1", chapterNumber: "1",
        name: "Upstream title", position: 1, page: "1", contentType: "html" as const, releaseTime: null }], primarySource: 0,
      user: { included: true, order: 1, name: "My saved title", chapterNumber: "1" } }] };
    const result = compileNovelMergeComposition({ sourceNovel: a, targetNovel: b, sourceComposition: old,
      sourceChapters: [{ ...original, path: "norea-composed:old-a", chapterNumber: "40", name: "My saved title" }],
      targetChapters: [chapter("b", 1)], entries: [{ key: "a", sourceChapterIds: [10001], primary: "source" }],
      now: 100, newId: (() => { let value = 0; return () => `next-${++value}`; })() });
    expect(result.targetChapters[0].name).toBe("My saved title");
    expect(result.composition.entries[0].sources[0].name).toBe("Upstream title");
    expect(result.composition.updatedAt).toBeGreaterThan(old.updatedAt);
  });

  it("keeps gaps, exclusions and final order separately from package numbers and origins", () => {
    const result = compile([
      { key: "b3", sourceChapterIds: [], targetChapterPath: "/b/3", primary: "target" },
      { key: "a1", sourceChapterIds: [10001], primary: "source", name: "My prologue" },
      { key: "pair", sourceChapterIds: [10002], targetChapterPath: "/b/1", primary: "target" },
    ]);
    const included = includedChapterCompositionEntries(result.composition);
    expect(included.map(row => [row.path, row.storageChapterNumber, row.user.order, row.user.chapterNumber])).toEqual([
      ["/b/3", "3", 1, "1"], ["norea-composed:entry-2", "4", 2, "2"], ["/b/1", "1", 3, "3"],
    ]);
    expect(included[1].user.name).toBe("My prologue");
    expect(included[1].sources[0]).toMatchObject({ pluginId: "source-a", novelId: "work-a", chapterPath: "/a/1", chapterNumber: "1" });
    expect(result.composition.entries.filter(row => !row.user.included).flatMap(row => row.sources.map(source => source.chapterPath)).sort()).toEqual(["/a/3", "/b/2"]);
    expect(result.decisions.find(row => row.sourceChapterId === 10003)).toEqual({ sourceChapterId: 10003, kind: "exclude" });
    expect(result.skipSourceContentChapterIds).toEqual([10002]);
  });

  it("allocates a clean A package even when the paired B chapter is downloaded", () => {
    const result = compile([{ key: "pair", sourceChapterIds: [10001], targetChapterPath: "/b/1", primary: "source" }],
      [chapter("a", 1, true)], [chapter("b", 1, true)]);
    const chosen = result.composition.entries[0];
    expect(chosen.path).toBe("norea-composed:entry-1");
    expect(chosen.storageChapterNumber).toBe("2");
    expect(chosen.sources[chosen.primarySource].pluginId).toBe("source-a");
    expect(result.targetChapters[0].isDownloaded).toBe(false);
    expect(result.readingStateSourcePathByTargetPath[chosen.path]).toBe("/b/1");
    expect(result.artifactSourceChapterIdByTargetPath[chosen.path]).toBe(10001);
    expect(result.composition.entries.find(row => row.path === "/b/1")?.user.included).toBe(false);
  });

  it("never substitutes an A saved body when the user chooses B", () => {
    const result = compile([{ key: "pair", sourceChapterIds: [10001], targetChapterPath: "/b/1", primary: "target" }],
      [chapter("a", 1, true)], [chapter("b", 1)]);
    expect(result.artifactSourceChapterIdByTargetPath).toEqual({});
    expect(result.skipSourceContentChapterIds).toEqual([10001]);
    expect(result.composition.entries[0].sources[result.composition.entries[0].primarySource].pluginId).toBe("source-b");
  });

  it("rejects duplicated source chapters and destination chapters before storage changes", () => {
    const entry: NovelMergeCompositionEntry = { key: "a", sourceChapterIds: [10001], targetChapterPath: "/b/1", primary: "source" };
    expect(() => validateNovelMergeComposition([entry, { ...entry, key: "b" }], [chapter("a", 1)], [chapter("b", 1)])).toThrow("more than once");
    expect(() => validateNovelMergeComposition([{ ...entry, sourceChapterIds: [10001, 10002] }], [chapter("a", 1), chapter("a", 2)], [chapter("b", 1)])).toThrow("Pair one");
  });

  it("handles a 2,000-chapter composition with omissions and reverse final ordering", () => {
    const source = Array.from({ length: 2000 }, (_, index) => chapter("a", index + 1));
    const target = Array.from({ length: 2000 }, (_, index) => chapter("b", index + 1));
    const entries = target.filter((_, index) => index < 500 || index >= 1500).reverse().map((row, index) => ({
      key: String(index), sourceChapterIds: [source[row.position - 1].id], targetChapterPath: row.path, primary: "target" as const,
    }));
    const result = compile(entries, source, target);
    const saved = parseChapterComposition(JSON.parse(JSON.stringify(result.composition)));
    expect(includedChapterCompositionEntries(saved).map(row => row.path)).toEqual(entries.map(row => row.targetChapterPath));
    expect(saved.entries.filter(row => !row.user.included)).toHaveLength(2000);
    expect(result.decisions).toHaveLength(2000);
  });
});

describe("source refreshes of a composed work", () => {
  it("retains user edits and exclusions while accepting renumbered and newly discovered source facts", () => {
    const previous = compile([
      { key: "b2", sourceChapterIds: [], targetChapterPath: "/b/2", primary: "target", name: "My first chapter" },
      { key: "a1", sourceChapterIds: [10001], primary: "source" },
    ]).composition;
    const b2 = previous.entries.find(row => row.path === "/b/2")!;
    b2.sources[0].sourceChapterId = "stable-b2";
    const refreshed = refreshChapterComposition(previous, { pluginId: "source-b", novelId: "work-b", novelPath: "/b" }, [
      { path: "/b/1", name: "Excluded provider chapter", chapterNumber: 101 },
      { path: "/b/new-2", sourceChapterId: "stable-b2", name: "Changed provider title", chapterNumber: 101.5 },
      { path: "/b/4", name: "New chapter", chapterNumber: 104 },
    ], { now: 200, newId: () => "new-four" });
    const list = includedChapterCompositionEntries(refreshed);
    expect(list.map(row => row.path)).toEqual(["/b/2", previous.entries[1].path, "/b/4"]);
    expect(list[0].user).toEqual(b2.user);
    expect(list[0].storageChapterNumber).toBe("2");
    expect(list[0].sources[0]).toMatchObject({ chapterPath: "/b/new-2", chapterNumber: "101.5", name: "Changed provider title", position: 2 });
    expect(refreshed.entries.find(row => row.path === "/b/1")?.user.included).toBe(false);
    expect(list[2].storageChapterNumber).not.toBe("104");
    expect(compositionSourceAnchor(refreshed, { pluginId: "source-b", novelId: "work-b" })).toEqual({ chapterNumber: 104, position: 3 });
  });

  it("produces the same new local paths in preview and commit and does not dirty a no-op refresh", () => {
    const previous = compile([{ key: "b1", sourceChapterIds: [], targetChapterPath: "/b/1", primary: "target" }], [], [chapter("b", 1)]).composition;
    const source = [{ path: "/b/1", name: "b chapter 1", chapterNumber: 1 }];
    expect(refreshChapterComposition(previous, { pluginId: "source-b", novelId: "work-b", novelPath: "/b" }, source, { now: 200 }).updatedAt).toBe(previous.updatedAt);
    const fresh = [...source, { path: "/b/2", name: "new", chapterNumber: 2 }];
    const preview = refreshChapterComposition(previous, { pluginId: "source-b", novelId: "work-b", novelPath: "/b" }, fresh, { newId: () => "preview" });
    const commit = refreshChapterComposition(previous, { pluginId: "source-b", novelId: "work-b", novelPath: "/b" }, fresh, { newId: () => "commit" });
    expect(preview.entries.map(row => row.path)).toEqual(commit.entries.map(row => row.path));
  });
});
