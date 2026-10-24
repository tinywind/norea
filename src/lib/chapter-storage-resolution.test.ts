import { beforeEach, expect, it } from "vitest";
import {
  clearAuthoritativeStorageDirs,
  forgetNovelStorageDirs,
  rememberAuthoritativeChapterStorageDir,
  rememberResolvedChapterStorageDir,
  rememberResolvedNovelStorageDir,
  resolvedChapterStorageDir,
  resolvedNovelStorageDir,
} from "./chapter-storage-resolution";

beforeEach(() => clearAuthoritativeStorageDirs());

it("forgets a deleted work's authoritative and fallback paths while retaining other works", () => {
  rememberResolvedNovelStorageDir(1, "contents/demo/one");
  rememberResolvedNovelStorageDir(2, "contents/demo/two");
  rememberAuthoritativeChapterStorageDir(11, "contents/demo/one/1");
  rememberResolvedChapterStorageDir(11, "contents/demo/one/old/content.html");
  rememberResolvedChapterStorageDir(12, "contents/demo/one/2/content.html");
  rememberAuthoritativeChapterStorageDir(21, "contents/demo/two/1");
  rememberResolvedChapterStorageDir(22, "contents/demo/two/2/content.html");

  forgetNovelStorageDirs(1, [11, 12]);

  expect(resolvedNovelStorageDir(1)).toBeNull();
  expect(resolvedChapterStorageDir(11)).toBeNull();
  expect(resolvedChapterStorageDir(12)).toBeNull();
  expect(resolvedNovelStorageDir(2)).toBe("contents/demo/two");
  expect(resolvedChapterStorageDir(21)).toBe("contents/demo/two/1");
  expect(resolvedChapterStorageDir(22)).toBe("contents/demo/two/2");
});
