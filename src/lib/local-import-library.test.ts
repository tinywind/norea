import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/queries/chapter", () => ({
  listChaptersByNovel: vi.fn(),
}));

vi.mock("../db/queries/novel", () => ({
  findLocalNovelByPath: vi.fn(),
  getNovelById: vi.fn(),
  upsertLocalNovel: vi.fn(),
}));

vi.mock("./local-chapter-storage", () => ({
  syncLocalChapterStorageAfterOrderChange: vi.fn(),
}));

vi.mock("./local-import", () => ({
  convertLocalImportFile: vi.fn(),
}));

vi.mock("./local-import-media", () => ({
  cacheLocalImportedChapterMedia: vi.fn(),
}));

import { listChaptersByNovel } from "../db/queries/chapter";
import {
  findLocalNovelByPath,
  getNovelById,
  upsertLocalNovel,
} from "../db/queries/novel";
import { syncLocalChapterStorageAfterOrderChange } from "./local-chapter-storage";
import { convertLocalImportFile } from "./local-import";
import { importLocalFileToLibrary } from "./local-import-library";
import { cacheLocalImportedChapterMedia } from "./local-import-media";

const cacheLocalImportedChapterMediaMock = vi.mocked(
  cacheLocalImportedChapterMedia,
);
const convertLocalImportFileMock = vi.mocked(convertLocalImportFile);
const findLocalNovelByPathMock = vi.mocked(findLocalNovelByPath);
const getNovelByIdMock = vi.mocked(getNovelById);
const listChaptersByNovelMock = vi.mocked(listChaptersByNovel);
const syncLocalChapterStorageAfterOrderChangeMock = vi.mocked(
  syncLocalChapterStorageAfterOrderChange,
);
const upsertLocalNovelMock = vi.mocked(upsertLocalNovel);

beforeEach(() => {
  cacheLocalImportedChapterMediaMock.mockReset();
  convertLocalImportFileMock.mockReset();
  findLocalNovelByPathMock.mockReset();
  getNovelByIdMock.mockReset();
  listChaptersByNovelMock.mockReset();
  syncLocalChapterStorageAfterOrderChangeMock.mockReset();
  upsertLocalNovelMock.mockReset();
});

describe("importLocalFileToLibrary", () => {
  it("applies a system-provided work name to storage and metadata", async () => {
    const file = new File(["epub"], "Document Name.epub", {
      type: "application/epub+zip",
    });
    convertLocalImportFileMock.mockResolvedValue({
      chapters: [
        {
          chapterNumber: 1,
          content: "<p>content</p>",
          contentBytes: 14,
          contentType: "epub",
          name: "Embedded Title",
          path: "local:epub:hash:0",
        },
      ],
      novel: {
        chapters: [],
        name: "Embedded Title",
        path: "local:epub:hash",
      },
    } as never);
    findLocalNovelByPathMock.mockResolvedValue(null);
    upsertLocalNovelMock.mockResolvedValue({
      changed: true,
      changedChapters: 1,
      chapterCount: 1,
      novelId: 31,
    });

    await importLocalFileToLibrary(file, {
      novelName: "Document Name",
    });

    expect(upsertLocalNovelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Document Name",
        path: "local:epub:hash",
      }),
    );
    expect(cacheLocalImportedChapterMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        novelId: 31,
        novelName: "Document Name",
        novelPath: "local:epub:hash",
      }),
    );
  });
});
