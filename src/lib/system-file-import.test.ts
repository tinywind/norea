import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/queries/chapter", () => ({
  findLocalImportedChapter: vi.fn(),
}));

vi.mock("./local-import", () => ({
  analyzeLocalImportFile: vi.fn(),
}));

vi.mock("./local-import-library", () => ({
  importLocalFileToLibrary: vi.fn(),
}));

import { findLocalImportedChapter } from "../db/queries/chapter";
import { analyzeLocalImportFile } from "./local-import";
import { importLocalFileToLibrary } from "./local-import-library";
import { importSystemOpenedFile } from "./system-file-import";

const analyzeLocalImportFileMock = vi.mocked(analyzeLocalImportFile);
const importLocalFileToLibraryMock = vi.mocked(importLocalFileToLibrary);
const findLocalImportedChapterMock = vi.mocked(findLocalImportedChapter);

beforeEach(() => {
  analyzeLocalImportFileMock.mockReset();
  importLocalFileToLibraryMock.mockReset();
  findLocalImportedChapterMock.mockReset();
});

describe("importSystemOpenedFile", () => {
  it("returns the exact imported file chapter in the shared local work", async () => {
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
    findLocalImportedChapterMock.mockResolvedValue({ id: 44, novelId: 21 });

    await expect(importSystemOpenedFile(file)).resolves.toEqual({
      chapterId: 44,
      novelId: 21,
    });
    expect(importLocalFileToLibraryMock).toHaveBeenCalledWith(file, {
      analysis,
    });
    expect(findLocalImportedChapterMock).toHaveBeenCalledWith("local:txt:hash");
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
    findLocalImportedChapterMock.mockResolvedValue(null);

    await expect(importSystemOpenedFile(file)).rejects.toThrow(
      "System-opened file import created no readable chapter.",
    );
  });
});
