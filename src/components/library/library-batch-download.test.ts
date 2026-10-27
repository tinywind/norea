import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryDownloadChapter } from "../../db/queries/chapter";
import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";

const mocks = vi.hoisted(() => ({
  listIds: vi.fn(),
  queued: new Set<number>(),
}));
vi.mock("../../db/queries/chapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../db/queries/chapter")>(),
  listUnqueuedChapterDownloadIds: mocks.listIds,
}));
vi.mock("../../lib/tasks/chapter-download", () => ({
  isChapterDownloadQueued: (id: number) => mocks.queued.has(id),
}));

import {
  getLibraryBatchDownloadTargets,
  hasLibraryBatchDownloadTargets,
} from "./library-batch-download";

function chapter(id: number, overrides: Partial<LibraryDownloadChapter> = {}): LibraryDownloadChapter {
  return {
    id,
    position: id,
    isDownloaded: false,
    isDownloadQueued: false,
    unread: true,
    ...overrides,
  } as LibraryDownloadChapter;
}

beforeEach(() => {
  mocks.listIds.mockReset().mockResolvedValue([]);
  mocks.queued.clear();
});

describe("library batch download targets", () => {
  it("queues only missing chapters that are absent from persisted and active jobs", () => {
    mocks.queued.add(3);
    const chapters = [
      chapter(1, { isDownloaded: true }),
      chapter(2, { isDownloadQueued: true }),
      chapter(3),
      chapter(4, { contentBytes: 10, mediaRepairNeeded: true }),
      chapter(5),
    ];
    expect(getLibraryBatchDownloadTargets("all", chapters, undefined).map((row) => row.id)).toEqual([5]);
    mocks.queued.delete(3);
    chapters[1]!.isDownloadQueued = false;
    expect(getLibraryBatchDownloadTargets("all", chapters, undefined).map((row) => row.id)).toEqual([2, 3, 5]);
  });

  it("re-enables a deleted download and an individually cancelled job while another job remains queued", async () => {
    mocks.listIds.mockResolvedValue([1, 2]);
    mocks.queued.add(1).add(2);
    expect(await hasLibraryBatchDownloadTargets([7])).toBe(false);
    mocks.queued.delete(1);
    expect(await hasLibraryBatchDownloadTargets([7])).toBe(true);
    expect(getLibraryBatchDownloadTargets("all", [chapter(1), chapter(2)], undefined).map((row) => row.id)).toEqual([1]);
  });

  it("keeps next-chapter and unread scopes after excluding existing jobs", () => {
    const chapters = Array.from({ length: 40 }, (_, index) => chapter(index + 1));
    chapters[4]!.isDownloadQueued = true;
    chapters[5]!.isDownloaded = true;
    chapters[6]!.isDownloadQueued = true;
    chapters[7]!.unread = false;
    expect(getLibraryBatchDownloadTargets("next10", chapters, 5).map((row) => row.id)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(getLibraryBatchDownloadTargets("next30", chapters, 5)).toHaveLength(30);
    expect(getLibraryBatchDownloadTargets("next10", chapters, undefined)).toEqual([]);
    expect(getLibraryBatchDownloadTargets("unread", chapters, undefined).some((row) => row.id === 8)).toBe(false);
  });

  it("uses chapter IDs to break equal-position ties", () => {
    expect(getLibraryBatchDownloadTargets("all", [chapter(2, { position: 1 }), chapter(1)], undefined).map((row) => row.id)).toEqual([1, 2]);
  });
});

describe("library download availability", () => {
  it("checks a newly selected work without waiting for other work downloads", async () => {
    mocks.queued.add(1);
    mocks.listIds.mockImplementation(async (novelId: number) => novelId === 7 ? [1] : [2]);
    expect(await hasLibraryBatchDownloadTargets([7])).toBe(false);
    expect(await hasLibraryBatchDownloadTargets([8])).toBe(true);
    expect(await hasLibraryBatchDownloadTargets([7, 8])).toBe(true);
    expect(await hasLibraryBatchDownloadTargets([])).toBe(false);
  });

  it("looks past a full page of not-yet-materialized jobs", async () => {
    const reservedIds = Array.from({ length: MAX_ROUTE_QUERY_ROWS }, (_, index) => index + 1);
    for (const id of reservedIds) mocks.queued.add(id);
    mocks.listIds.mockResolvedValueOnce(reservedIds).mockResolvedValueOnce([MAX_ROUTE_QUERY_ROWS + 1]);
    expect(await hasLibraryBatchDownloadTargets([7])).toBe(true);
    expect(mocks.listIds.mock.calls).toEqual([[7, 0], [7, MAX_ROUTE_QUERY_ROWS]]);
  });

  it("stops a cancelled availability scan before reading another selected work", async () => {
    let release!: (ids: number[]) => void;
    mocks.listIds.mockImplementationOnce(() => new Promise<number[]>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const scan = hasLibraryBatchDownloadTargets([7, 8], controller.signal);
    controller.abort();
    release([]);
    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.listIds).toHaveBeenCalledExactlyOnceWith(7, 0);
  });
});
