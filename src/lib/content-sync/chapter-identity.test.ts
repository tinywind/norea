import { expect, it } from "vitest";
import { isSameServerChapter } from "./chapter-identity";

it("matches a server chapter by its exact source path", () => {
  expect(isSameServerChapter({ chapterPath: "/chapter/7", chapterNumber: "9" }, { chapterPath: "/chapter/7", chapterNumber: "7" })).toBe(true);
});

it("never treats different source paths as one chapter because their numbers match", () => {
  expect(isSameServerChapter({ chapterPath: "/ep-254", chapterNumber: "476" }, { chapterPath: "/ep-243", chapterNumber: "476" })).toBe(false);
});

it("matches a recovered folder chapter by its chapter number on either side", () => {
  expect(isSameServerChapter({ chapterPath: "norea-folder:7", chapterNumber: null }, { chapterPath: "/chapter/7", chapterNumber: "7" })).toBe(true);
  expect(isSameServerChapter({ chapterPath: "/chapter/7", chapterNumber: "7.0" }, { chapterPath: "norea-folder:7", chapterNumber: undefined })).toBe(true);
  expect(isSameServerChapter({ chapterPath: "norea-folder:7", chapterNumber: "7" }, { chapterPath: "/chapter/8", chapterNumber: "8" })).toBe(false);
});
