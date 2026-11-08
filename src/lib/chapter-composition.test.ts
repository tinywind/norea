import { describe, expect, it } from "vitest";
import {
  chapterCompositionCatalog, getChapterCompositionDisplay, parseChapterComposition,
  type ChapterCompositionEntry, type ChapterCompositionV1,
} from "./chapter-composition";
import { parseNovelMetadata } from "./work-metadata/schema";
import { mergeIncomingNovelMetadata } from "./work-metadata/merge";

function entry(number: number, order: number, included = true): ChapterCompositionEntry {
  return {
    id: "entry-" + number, path: "/chapter/" + number, storageChapterNumber: String(number),
    sources: [{
      pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/raw/" + number,
      sourceChapterId: "raw-" + number, chapterNumber: String(number + 10),
      name: "Source " + number, position: number, page: "2", contentType: "html", releaseTime: null,
    }],
    primarySource: 0,
    user: { included, order, name: number === 2 ? "My opening" : null, chapterNumber: included ? String(order) : null },
  };
}
function composition(): ChapterCompositionV1 {
  return { version: 1, updatedAt: 20, entries: [entry(1, 2), entry(2, 1), entry(3, 0, false)] };
}
function metadata(chapterComposition?: ChapterCompositionV1) {
  return parseNovelMetadata({
    schemaVersion: 1, identity: { pluginId: "source", novelId: "book", novelPath: "/book" },
    novel: { name: "Book" }, cover: null,
    chapters: chapterComposition ? chapterCompositionCatalog(chapterComposition) : { "1": "Upstream", "3": "Excluded upstream" },
    ...(chapterComposition ? { chapterComposition } : {}),
  });
}

describe("chapter composition persistence", () => {
  it("round-trips source snapshots separately from user names, order and exclusion", () => {
    const original = composition();
    const parsed = parseChapterComposition(JSON.parse(JSON.stringify(original)));
    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(chapterCompositionCatalog(parsed)).toEqual({ "1": "Source 1", "2": "My opening" });
    expect(getChapterCompositionDisplay(parsed, "/chapter/2")).toEqual({
      included: true, name: "My opening", chapterNumber: "1", position: 1,
    });
    expect(parsed.entries[1]!.sources[0]!.chapterNumber).toBe("12");
    expect(parsed.entries[1]!.storageChapterNumber).toBe("2");
    expect(metadata(parsed).chapterComposition).toEqual(original);
  });

  it("rejects a metadata catalog that would resurrect an excluded chapter", () => {
    expect(() => parseNovelMetadata({ ...metadata(composition()), chapters: { "1": "Source 1", "2": "My opening", "3": "Source 3" } }))
      .toThrow(/does not match/);
  });

  it("keeps a custom list when metadata omits it or carries an older composition", () => {
    const current = metadata(composition());
    expect(mergeIncomingNovelMetadata(current, metadata()).chapterComposition).toEqual(composition());
    const older = composition(); older.updatedAt = 10; older.entries[1]!.user.name = "Old edit";
    expect(mergeIncomingNovelMetadata(current, metadata(older))).toMatchObject({
      chapterComposition: composition(), chapters: chapterCompositionCatalog(composition()),
    });
    const newer = composition(); newer.updatedAt = 30; newer.entries[1]!.user.name = "New edit";
    expect(mergeIncomingNovelMetadata(current, metadata(newer)).chapterComposition).toEqual(newer);
  });

  it.each([
    (value: ChapterCompositionV1) => { value.entries[1]!.id = value.entries[0]!.id; },
    (value: ChapterCompositionV1) => { value.entries[1]!.path = value.entries[0]!.path; },
    (value: ChapterCompositionV1) => { value.entries[1]!.storageChapterNumber = "1"; },
    (value: ChapterCompositionV1) => { value.entries[1]!.storageChapterNumber = "01"; },
    (value: ChapterCompositionV1) => { value.entries[1]!.primarySource = 1; },
    (value: ChapterCompositionV1) => { value.entries[1]!.user.order = 4; },
    (value: ChapterCompositionV1) => { value.entries[1]!.sources = []; },
    (value: ChapterCompositionV1) => { value.entries[1]!.sources[0]!.novelId = "../book"; },
    (value: ChapterCompositionV1) => { value.entries[1]!.user.name = "\ud800"; },
    (value: ChapterCompositionV1) => { value.updatedAt = -1; },
  ])("rejects ambiguous or corrupt persisted composition %#", mutate => {
    const value = composition(); mutate(value);
    expect(() => parseChapterComposition(value)).toThrow();
  });

  it("supports a 2,000-chapter custom order without changing physical storage keys", () => {
    const value: ChapterCompositionV1 = {
      version: 1, updatedAt: 1, entries: Array.from({ length: 2000 }, (_, index) => entry(index + 1, 2000 - index)),
    };
    const parsed = parseChapterComposition(value);
    expect(Object.keys(chapterCompositionCatalog(parsed))).toHaveLength(2000);
    expect(getChapterCompositionDisplay(parsed, "/chapter/2000")?.position).toBe(1);
    expect(parsed.entries[1999]!.storageChapterNumber).toBe("2000");
  });
});
