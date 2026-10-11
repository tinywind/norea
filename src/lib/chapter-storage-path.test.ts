import { beforeEach, expect, it } from "vitest";
import { chapterStorageRelativeDir, novelStorageRelativeDir } from "./chapter-storage-path";
import { clearAuthoritativeStorageDirs } from "./chapter-storage-resolution";

beforeEach(() => clearAuthoritativeStorageDirs());

it("uses the same readable work directory for source and server metadata", () => {
  const novel = { pluginId: "newtoki-webtoon", path: "/webtoon/10557", name: "A title" };
  expect(chapterStorageRelativeDir(novel, { chapterNumber: "1", name: "Opening" }))
    .toBe("contents/newtoki-webtoon/A-title-webtoon-10557/1-Opening");
});

it("keeps the existing directory convention for source paths", () => {
  expect(novelStorageRelativeDir({ pluginId: "newtoki-webtoon", path: "/webtoon/10557", name: "A title" }))
    .toBe("contents/newtoki-webtoon/A-title-webtoon-10557");
});
