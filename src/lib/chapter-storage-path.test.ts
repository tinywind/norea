import { beforeEach, expect, it } from "vitest";
import { chapterStorageRelativeDir, novelStorageRelativeDir } from "./chapter-storage-path";
import { clearAuthoritativeStorageDirs } from "./chapter-storage-resolution";

beforeEach(() => clearAuthoritativeStorageDirs());

it("uses the plugin-owned work ID and chapter sequence without titles", () => {
  const novel = { pluginId: "newtoki-webtoon", sourceNovelId: "10557", path: "/webtoon/10557", name: "A title" };
  expect(chapterStorageRelativeDir(novel, { chapterNumber: "1", name: "Opening" }))
    .toBe("contents/newtoki-webtoon/10557/1");
  expect(chapterStorageRelativeDir({ ...novel, name: "Renamed" }, { chapterNumber: "2.5", name: "Changed" }))
    .toBe("contents/newtoki-webtoon/10557/2.5");
});

it.each(["", ".hidden", "..", "a/b", "a\\b", "CON", "a.", "a ", "a.tmp", "a".repeat(241)])("rejects unsafe plugin-owned work IDs %s", (sourceNovelId) => {
  expect(() => novelStorageRelativeDir({ pluginId: "source", sourceNovelId, path: "/book", name: "Book" })).toThrow();
});

it("keeps different plugin-owned IDs separate even when source paths sanitize identically", () => {
  expect(novelStorageRelativeDir({ pluginId: "source", sourceNovelId: "one", path: "/a/b", name: "Book" })).toBe("contents/source/one");
  expect(novelStorageRelativeDir({ pluginId: "source", sourceNovelId: "two", path: "/a-b", name: "Book" })).toBe("contents/source/two");
});
