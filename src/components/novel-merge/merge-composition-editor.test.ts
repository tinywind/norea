import { describe, expect, it } from "vitest";
import type { NovelMergeCompositionEntry } from "../../lib/novel-merge-composition";
import {
  createInitialComposition, excludeCompositionOrigins,
  includeSourceChapters, includeTargetChapters, moveCompositionEntries,
  pairCompositionRanges, selectCompositionRange, splitCompositionEntries,
  summarizeComposition, toggleCompositionSelection, refreshCompositionCatalog,
} from "./merge-composition-editor";

const a = (id: number): NovelMergeCompositionEntry => ({
  key: `source:${id}`, sourceChapterIds: [id], primary: "source",
});
const b = (id: number, sourceId?: number): NovelMergeCompositionEntry => ({
  key: `target:/b/${id}`, sourceChapterIds: sourceId === undefined ? [] : [sourceId],
  targetChapterPath: `/b/${id}`, primary: "target",
});
const unmatched = { ambiguous: [], matched: [], unmatchedSourceChapterIds: [] };

function origins(entries: readonly NovelMergeCompositionEntry[]) {
  return {
    sources: entries.flatMap(entry => entry.sourceChapterIds).sort((a, b) => a - b),
    targets: entries.flatMap(entry => entry.targetChapterPath === undefined ? [] : [entry.targetChapterPath]).sort(),
  };
}

describe("chapter composition editor", () => {
  it("keeps missing chapters from either source and places A gaps beside their matched neighbors", () => {
    const result = createInitialComposition(
      [1, 2, 3, 4, 5].map(id => ({ id })),
      [2, 4, 9].map(id => ({ path: `/b/${id}` })),
      { ...unmatched, matched: [
        { sourceChapterId: 2, targetChapterPath: "/b/2" },
        { sourceChapterId: 4, targetChapterPath: "/b/4" },
      ] },
    );
    expect(result).toEqual([a(1), b(2, 2), a(3), b(4, 4), a(5), b(9)]);
    expect(origins(result)).toEqual({ sources: [1, 2, 3, 4, 5], targets: ["/b/2", "/b/4", "/b/9"] });
  });

  it("keeps every chapter when there are no reliable matches or no B catalog", () => {
    expect(createInitialComposition([{ id: 1 }, { id: 2 }], [{ path: "/b/1" }], unmatched)).toEqual([b(1), a(1), a(2)]);
    expect(createInitialComposition([{ id: 1 }, { id: 2 }], [], unmatched)).toEqual([a(1), a(2)]);
  });

  it("keeps downloaded A bodies by default while using B for undownloaded matches", () => {
    const result = createInitialComposition(
      [{ id: 1, isDownloaded: true }, { id: 2, contentBytes: 100 }, { id: 3, isDownloaded: false }],
      [1, 2, 3].map(id => ({ path: `/b/${id}` })),
      { ...unmatched, matched: [1, 2, 3].map(id => ({ sourceChapterId: id, targetChapterPath: `/b/${id}` })) },
    );
    expect(result.map(entry => entry.primary)).toEqual(["source", "source", "target"]);
    expect(pairCompositionRanges([b(1), b(2)], [1, 2], ["/b/1", "/b/2"], new Set([1])).map(entry => entry.primary)).toEqual(["source", "target"]);
  });

  it("selects and removes a 2,000-chapter range in one operation using positions rather than source IDs", () => {
    const ids = Array.from({ length: 2000 }, (_, index) => 10000 + index * 3);
    const selected = selectCompositionRange(ids, 1, 2000);
    expect(selected.size).toBe(2000);
    const result = excludeCompositionOrigins(ids.map(a), selected, new Set());
    expect(result).toEqual([]);
    expect(includeSourceChapters(result, ids)).toEqual(ids.map(a));
  });

  it("supports reverse ranges, filtered Shift selection, and invalid range input", () => {
    expect([...selectCompositionRange([10, 20, 30, 40], 4, 2)]).toEqual([20, 30, 40]);
    expect([...toggleCompositionSelection(new Set([99]), [10, 30, 40], 40, 10, true)]).toEqual([99, 10, 30, 40]);
    expect(selectCompositionRange([10, 20], NaN, 2).size).toBe(0);
    expect(selectCompositionRange([10, 20], 1.5, 2).size).toBe(0);
  });

  it("removes just the chosen source from pairs and keeps the other original", () => {
    const original = [b(1, 1), b(2, 2), a(3)];
    expect(excludeCompositionOrigins(original, new Set([1]), new Set(["/b/2"]))).toEqual([b(1), a(2), a(3)]);
    expect(original).toEqual([b(1, 1), b(2, 2), a(3)]);
  });

  it("restores exclusions at the selected position without duplicating included chapters", () => {
    const sources = includeSourceChapters([b(1, 1), b(3)], [1, 2, 2], "target:/b/3");
    expect(sources).toEqual([b(1, 1), a(2), b(3)]);
    expect(includeTargetChapters(sources, ["/b/1", "/b/2", "/b/2"], "source:2")).toEqual([b(1, 1), b(2), a(2), b(3)]);
  });

  it("pairs ranges despite gaps and preserves displaced partners", () => {
    const original = [b(1, 1), b(2, 2), b(3, 3), a(4)];
    const result = pairCompositionRanges(original, [2, 4], ["/b/1", "/b/3"]);
    expect(result).toEqual([b(1, 2), a(1), b(2), b(3, 4), a(3)]);
    expect(origins(result)).toEqual(origins(original));
    expect(new Set(result.map(entry => entry.key)).size).toBe(result.length);
    expect(pairCompositionRanges(original, [1, 2], ["/b/1"])).toEqual(original);
  });

  it("pairs previously excluded catalog ranges without reviving unrelated chapters", () => {
    const result = pairCompositionRanges([b(1)], [2, 3], ["/b/2", "/b/3"]);
    expect(result).toEqual([b(1), b(2, 2), b(3, 3)]);
  });

  it("moves a noncontiguous selection as a block and preserves its reading order", () => {
    const original = [a(1), a(2), a(3), a(4), a(5)];
    const selected = new Set(["source:2", "source:4"]);
    expect(moveCompositionEntries(original, selected, 4)).toEqual([a(1), a(3), a(5), a(2), a(4)]);
    expect(moveCompositionEntries(original, selected, 1)).toEqual([a(2), a(4), a(1), a(3), a(5)]);
    expect(moveCompositionEntries(original, selected, NaN)).toEqual(original);
    expect(original).toEqual([a(1), a(2), a(3), a(4), a(5)]);
  });

  it("splits pairs without losing either origin and reports omissions from both catalogs", () => {
    const result = splitCompositionEntries([{ ...b(1, 1), name: "Custom title" }, b(2)], new Set(["target:/b/1"]));
    expect(result).toEqual([a(1), { ...b(1), name: "Custom title" }, b(2)]);
    expect(summarizeComposition(result, [{ id: 1 }, { id: 2 }], [1, 2, 3].map(id => ({ path: `/b/${id}` })))).toEqual({
      total: 3, paired: 0, sourceOnly: 1, targetOnly: 2, excludedSource: 1, excludedTarget: 1,
    });
  });

  it("keeps edited order, titles, and exclusions when catalogs are reloaded and appends unseen chapters", () => {
    const result = refreshCompositionCatalog({
      composition: [{ ...b(2, 2), name: "My title" }, a(1)],
      previousSourceChapterIds: [1, 2, 3], previousTargetChapterPaths: ["/b/1", "/b/2"],
      sourceChapterIds: [1, 2, 3, 4], targetChapterPaths: ["/b/1", "/b/2", "/b/3"],
    });
    expect(result).toEqual([{ ...b(2, 2), name: "My title" }, a(1), a(4), b(3)]);
    expect(origins(result).sources).not.toContain(3);
    expect(origins(result).targets).not.toContain("/b/1");
  });

  it("retains the surviving source and its title when one side of a pair disappears", () => {
    expect(refreshCompositionCatalog({
      composition: [{ ...b(1, 1), name: "My title" }],
      previousSourceChapterIds: [1], previousTargetChapterPaths: ["/b/1"],
      sourceChapterIds: [1], targetChapterPaths: [],
    })).toEqual([{ ...a(1), name: "My title" }]);
  });
});
