import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/queries/chapter", () => ({
  listChaptersByNovel: vi.fn(),
}));

vi.mock("./local-import", () => ({
  analyzeLocalImportFile: vi.fn(),
}));

vi.mock("./local-import-library", () => ({
  importLocalFileToLibrary: vi.fn(),
}));

import { listChaptersByNovel } from "../db/queries/chapter";
import { analyzeLocalImportFile } from "./local-import";
import { importLocalFileToLibrary } from "./local-import-library";
import { importSystemOpenedFile } from "./system-file-import";

const analyzeLocalImportFileMock = vi.mocked(analyzeLocalImportFile);
const importLocalFileToLibraryMock = vi.mocked(importLocalFileToLibrary);
const listChaptersByNovelMock = vi.mocked(listChaptersByNovel);

beforeEach(() => {
  analyzeLocalImportFileMock.mockReset();
  importLocalFileToLibraryMock.mockReset();
  listChaptersByNovelMock.mockReset();
});

describe("importSystemOpenedFile", () => {
  it("uses the file name for the work home and returns its first chapter", async () => {
    const file = new File(["text"], "My Book.txt", { type: "text/plain" });
    const analysis = {
      contentHash: "hash",
      duplicate: {
        contentHash: "hash",
        fileName: "My Book.txt",
        fileSize: 4,
        format: "txt" as const,
        key: "hash",
        pathKey: "local:txt:hash",
        strategy: "content-hash" as const,
      },
      fileName: "My Book.txt",
      fileSize: 4,
      format: "txt" as const,
      mimeType: "text/plain",
      pathKey: "local:txt:hash",
      title: "My Book",
    };
    analyzeLocalImportFileMock.mockResolvedValue(analysis);
    importLocalFileToLibraryMock.mockResolvedValue({
      changed: true,
      changedChapters: 1,
      chapterCount: 1,
      novelId: 21,
    });
    listChaptersByNovelMock.mockResolvedValue([{ id: 44 }] as never);

    await expect(importSystemOpenedFile(file)).resolves.toEqual({
      chapterId: 44,
      novelId: 21,
    });
    expect(importLocalFileToLibraryMock).toHaveBeenCalledWith(file, {
      analysis,
      novelName: "My Book",
    });
    expect(listChaptersByNovelMock).toHaveBeenCalledWith(21);
  });

  it("fails when the imported work has no readable chapter", async () => {
    const file = new File(["text"], "Empty.txt", { type: "text/plain" });
    analyzeLocalImportFileMock.mockResolvedValue({
      contentHash: "empty",
      duplicate: {
        contentHash: "empty",
        fileName: "Empty.txt",
        fileSize: 4,
        format: "txt",
        key: "empty",
        pathKey: "local:txt:empty",
        strategy: "content-hash",
      },
      fileName: "Empty.txt",
      fileSize: 4,
      format: "txt",
      mimeType: "text/plain",
      pathKey: "local:txt:empty",
      title: "Empty",
    });
    importLocalFileToLibraryMock.mockResolvedValue({
      changed: true,
      changedChapters: 0,
      chapterCount: 0,
      novelId: 22,
    });
    listChaptersByNovelMock.mockResolvedValue([]);

    await expect(importSystemOpenedFile(file)).rejects.toThrow(
      "System-opened file import created no readable chapter.",
    );
  });
});
