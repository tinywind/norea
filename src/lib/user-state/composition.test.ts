import { describe, expect, it } from "vitest";
import { mergeUserStateComposition } from "./composition";
import type { ChapterCompositionEntry, ChapterCompositionV1 } from "../chapter-composition";

const owner = { pluginId: "provider", sourceNovelId: "work-b" };
function entry(index: number, patch: Partial<ChapterCompositionEntry> = {}): ChapterCompositionEntry {
  return { id: "entry-" + index, path: "/chapter/" + index, storageChapterNumber: String(index),
    sources: [{ pluginId: "provider", novelId: "work-b", novelPath: "/work/b", chapterPath: "/chapter/" + index,
      sourceChapterId: "chapter-" + index, chapterNumber: String(index), name: "Source " + index, position: index,
      page: "1", contentType: "html", releaseTime: null }],
    primarySource: 0, user: { included: true, order: index, name: null, chapterNumber: String(index) }, ...patch };
}
function doc(entries: ChapterCompositionEntry[], updatedAt = 10): ChapterCompositionV1 {
  return { version: 1, updatedAt, entries };
}

describe("shared chapter composition overlay", () => {
  it("keeps manual order, labels, primary sources and exclusions while refreshing exact provider facts", () => {
    const first = entry(1); first.user = { included: true, order: 1, name: "My title", chapterNumber: "Prologue" };
    const second = entry(2); second.user = { included: false, order: 0, name: null, chapterNumber: null };
    const shared = doc([first, second]);
    const refreshed = doc([entry(1), entry(2)], 20);
    refreshed.entries[0].sources[0].name = "Renamed source";
    refreshed.entries[1].sources[0].name = "Hidden source update";
    const result = mergeUserStateComposition(shared, refreshed, owner);
    expect(result.entries[0].sources[0].name).toBe("Renamed source");
    expect(result.entries[0].user).toEqual(first.user);
    expect(result.entries[1].sources[0].name).toBe("Hidden source update");
    expect(result.entries[1].user.included).toBe(false);
    expect(shared.entries[0].sources[0].name).toBe("Source 1");
    expect(result.updatedAt).toBe(20);
  });

  it("appends genuinely new default target chapters without restoring another source's old user additions", () => {
    const shared = doc([entry(1)]);
    const foreign = entry(3);
    foreign.sources[0].novelId = "work-a"; foreign.sources[0].chapterPath = "/a/3";
    const edited = entry(4); edited.user.name = "An older manual addition";
    const result = mergeUserStateComposition(shared, doc([entry(1), entry(2), foreign, edited], 30), owner);
    expect(result.entries.map(row => row.id)).toEqual(["entry-1", "entry-2"]);
    expect(result.entries[1].user.order).toBe(2);
  });

  it("matches moved source paths only by an exact stable source ID and preserves target file identity", () => {
    const shared = doc([entry(1)]);
    const moved = entry(1); moved.id = "other-device-entry";
    moved.sources[0].chapterPath = "/new/1"; moved.path = "/new/1";
    const result = mergeUserStateComposition(shared, doc([moved], 20), owner);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ id: "entry-1", path: "/chapter/1", storageChapterNumber: "1" });
    expect(result.entries[0].sources[0].chapterPath).toBe("/new/1");
  });

  it("does not treat matching titles or chapter numbers as source identity", () => {
    const shared = doc([entry(1)]);
    const unrelated = entry(1);
    unrelated.id = "other-entry"; unrelated.path = "/unrelated"; unrelated.storageChapterNumber = "2";
    unrelated.sources[0].chapterPath = "/unrelated"; unrelated.sources[0].sourceChapterId = "unrelated";
    const result = mergeUserStateComposition(shared, doc([unrelated], 20), owner);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].sources[0].chapterPath).toBe("/chapter/1");
  });

  it("rejects a newly discovered entry that would adopt another entry's physical storage", () => {
    const shared = doc([entry(1)]);
    const second = entry(2); second.storageChapterNumber = "1"; second.user.order = 1; second.user.chapterNumber = "1";
    expect(() => mergeUserStateComposition(shared, doc([second], 20), owner)).toThrow("retained composition storage");
  });

  it("retains excluded origins even if source snapshots in multiple entries are ambiguous", () => {
    const first = entry(1); first.user = { included: false, order: 0, name: null, chapterNumber: null };
    const duplicate = entry(2); duplicate.sources = structuredClone(first.sources);
    duplicate.sources[0].name = "Alternative snapshot";
    duplicate.user = { included: false, order: 0, name: null, chapterNumber: null };
    const source = entry(3); source.sources = structuredClone(first.sources);
    source.path = first.path; source.user.order = 1; source.user.chapterNumber = "1";
    expect(mergeUserStateComposition(doc([first, duplicate]), doc([source], 20), owner).entries).toHaveLength(2);
  });

  it("does not advance metadata for a no-op and leaves older snapshots unchanged", () => {
    const shared = doc([entry(1)]);
    expect(mergeUserStateComposition(shared, doc([entry(1)], 20), owner)).toEqual(shared);
    const old = entry(1); old.sources[0].name = "Outdated";
    expect(mergeUserStateComposition(shared, doc([old], 1), owner)).toEqual(shared);
    expect(mergeUserStateComposition(shared, null, owner)).toEqual(shared);
  });
});
