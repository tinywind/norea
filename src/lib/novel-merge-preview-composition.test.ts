import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../db/client", () => ({ getDb: vi.fn() }));
vi.mock("../db/chapter-composition", () => ({ getChapterComposition: vi.fn(async () => null) }));
vi.mock("../db/queries/chapter", () => ({ listChaptersByNovel: vi.fn(async () => []) }));
import { getDb } from "../db/client";
import { listChaptersByNovel } from "../db/queries/chapter";
import { resolveNovelMergeTargetPreview, validateReviewedNovelMergeCatalog } from "./novel-merge-composition";
const raw = { novelId: "work-b", path: "/b", name: "B", chapters: [{ path: "/b/2", name: "Current", chapterNumber: 2 }] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDb).mockResolvedValue({ select: vi.fn(async () => [{ id: 2 }]) } as never);
});
describe("reviewed composition catalog", () => {
  it("includes a stored chapter omitted by the live provider, so it is never silently excluded", async () => {
    vi.mocked(listChaptersByNovel).mockResolvedValueOnce([
      { id: 21, novelId: 2, path: "/b/1", name: "Stored missing episode", chapterNumber: "1", position: 1, page: "1", releaseTime: null, sourceContentType: "html", isDownloaded: true },
      { id: 22, novelId: 2, path: "/b/2", name: "Cached title", chapterNumber: "2", position: 2, page: "1", releaseTime: null, sourceContentType: "html" },
    ] as never);
    const result = await resolveNovelMergeTargetPreview("source-b", raw);
    expect(result.chapters.map(row => [row.path, row.name])).toEqual([
      ["/b/1", "Stored missing episode"], ["/b/2", "Current"],
    ]);
    expect(() => validateReviewedNovelMergeCatalog({ sourceChapterIds: [11], targetChapterPaths: result.chapters.map(row => row.path) },
      [{ id: 11 }], [{ path: "/b/1" }, { path: "/b/2" }])).not.toThrow();
  });
  it("requires a fresh review for newly arrived source chapters and missing reviewed targets", () => {
    const reviewed = { sourceChapterIds: [11], targetChapterPaths: ["/b/1"] };
    expect(() => validateReviewedNovelMergeCatalog(reviewed, [{ id: 11 }, { id: 12 }], [{ path: "/b/1" }])).toThrow("NOVEL_MERGE_CATALOG_CHANGED");
    expect(() => validateReviewedNovelMergeCatalog(reviewed, [{ id: 11 }], [])).toThrow("NOVEL_MERGE_CATALOG_CHANGED");
    expect(() => validateReviewedNovelMergeCatalog(undefined, [{ id: 11 }], [{ path: "/b/1" }])).toThrow("NOVEL_MERGE_CATALOG_CHANGED");
  });
});
