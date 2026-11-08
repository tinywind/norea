import { beforeEach, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { LibraryDownloadChapter } from "../../db/queries/chapter";

const mocks = vi.hoisted(() => ({
  chapters: [] as unknown[], libraryChapters: vi.fn(), unqueued: vi.fn(), getNovel: vi.fn(), queued: new Set<number>(),
  reading: {} as Record<number, number>, serverSource: vi.fn(), available: vi.fn(), submit: vi.fn(), invalidate: vi.fn(async () => undefined),
}));
vi.mock("../../db/queries/chapter", async original => ({
  ...await original<typeof import("../../db/queries/chapter")>(),
  listLibraryDownloadChapters: mocks.libraryChapters,
  listUnqueuedChapterDownloads: mocks.unqueued,
}));
vi.mock("../../db/queries/novel", () => ({ getNovelById: mocks.getNovel }));
vi.mock("../../lib/content-sync/novel-source", () => ({ readServerNovelSource: mocks.serverSource, listServerChapterAvailability: mocks.available }));
vi.mock("../../lib/tasks/chapter-download", () => ({ isChapterDownloadQueued: (id: number) => mocks.queued.has(id) }));
vi.mock("../../lib/tasks/chapter-download-requests", () => ({ submitChapterDownloadRequest: mocks.submit }));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ lastReadChapterByNovel: mocks.reading }) } }));
import { downloadOnceNotice, queueChapterDownloadsOnce, selectDownloadChaptersOnce } from "./download-once";
const chapter = (id: number, extra: Partial<LibraryDownloadChapter> = {}) => ({
  id, novelId: 1, name: `Chapter ${id}`, path: `/chapter/${id}`, chapterNumber: String(id), position: id,
  isDownloaded: false, contentBytes: 0, mediaRepairNeeded: false, isDownloadQueued: false, readAt: null, contentType: "html",
  ...extra,
}) as LibraryDownloadChapter;
const t = (key: string) => key;
const client = { invalidateQueries: mocks.invalidate } as unknown as QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.queued = new Set(); mocks.reading = { 1: 2 };
  mocks.chapters = [chapter(1), chapter(2), chapter(3, { contentBytes: 10, mediaRepairNeeded: true }),
    chapter(4, { isDownloadQueued: true }), chapter(5), chapter(6)];
  mocks.getNovel.mockImplementation(async (id: number) => ({ id, pluginId: "source", name: "Book", path: "/book", isLocal: false }));
  mocks.libraryChapters.mockImplementation(async () => mocks.chapters);
  mocks.unqueued.mockResolvedValue([]);
  mocks.serverSource.mockResolvedValue(null);
  mocks.available.mockReset().mockResolvedValue({ paths: new Map(), numbers: new Map() });
  mocks.submit.mockReturnValue({ id: "request", materialized: Promise.resolve(), promise: Promise.resolve() });
});

it("keeps next-N inside its chosen range instead of filling beyond stored or queued chapters", () => {
  const rows = mocks.chapters as LibraryDownloadChapter[];
  expect(selectDownloadChaptersOnce(rows, { kind: "next", count: 2 }, 2)).toEqual([]);
  expect(selectDownloadChaptersOnce(rows, { kind: "next", count: 4 }, 2).map(row => row.id)).toEqual([5, 6]);
});

it("uses the remembered or latest reading position and leaves all-before-current chapters out", () => {
  const rows = (mocks.chapters as LibraryDownloadChapter[]).map(row => row.id === 2 ? { ...row, readAt: 20 } : row);
  mocks.queued.add(6);
  expect(selectDownloadChaptersOnce(rows, { kind: "remaining" }, undefined).map(row => row.id)).toEqual([5]);
  expect(selectDownloadChaptersOnce(rows, { kind: "remaining" }, 5).map(row => row.id)).toEqual([]);
});

it("queues the same immediate range once per selected work at user priority without an automatic goal", async () => {
  await expect(queueChapterDownloadsOnce([1, 1], t, client, { kind: "next", count: 4 })).resolves.toEqual({ queued: 2, skippedLocal: 0 });
  expect(mocks.submit).toHaveBeenCalledOnce();
  const request = mocks.submit.mock.calls[0]![0];
  const batch = await request.prepare();
  expect(batch.jobs.map((job: { id: number }) => job.id)).toEqual([5, 6]);
  for (const job of batch.jobs) {
    expect(job).toMatchObject({ pluginId: "source", novelId: 1, priority: "user" });
    expect(job.goal).toBeUndefined();
  }
  expect(mocks.unqueued).not.toHaveBeenCalled();
});

it("keeps the all-missing path paged and skips only local works without a remembered server", async () => {
  mocks.unqueued.mockResolvedValue([chapter(1), chapter(5)]);
  mocks.getNovel.mockImplementation(async (id: number) => ({ id, pluginId: "source", name: "Book", path: "/book", isLocal: id === 2 }));
  mocks.queued.add(5);
  await expect(queueChapterDownloadsOnce([1, 2], t, client, { kind: "all" })).resolves.toEqual({ queued: 1, skippedLocal: 1 });
  expect(mocks.serverSource).toHaveBeenCalledExactlyOnceWith(2);
  expect(mocks.unqueued).toHaveBeenCalledExactlyOnceWith(1, 0);
  expect((await mocks.submit.mock.calls[0]![0].prepare()).jobs.map((job: { id: number }) => job.id)).toEqual([1]);
});

it.each([{ kind: "all" } as const, { kind: "next", count: 4 } as const])("queues a local server-backed work through the existing user-request path for $kind", async selection => {
  mocks.getNovel.mockResolvedValue({ id: 1, pluginId: "source", name: "Book", path: "/book", isLocal: true });
  mocks.serverSource.mockResolvedValue({ serverUrl: "https://content.example", workId: "server-work" });
  mocks.chapters = [chapter(3, { contentBytes: 10 }), chapter(4, { isDownloadQueued: true }), chapter(5), chapter(6)];

  await expect(queueChapterDownloadsOnce([1], t, client, selection)).resolves.toEqual({ queued: 2, skippedLocal: 0 });
  expect(mocks.serverSource).toHaveBeenCalledExactlyOnceWith(1);
  expect(mocks.unqueued).not.toHaveBeenCalled();
  expect(mocks.libraryChapters).toHaveBeenCalledExactlyOnceWith(1);
  expect(mocks.submit).toHaveBeenCalledOnce();
  const batch = await mocks.submit.mock.calls[0]![0].prepare();
  expect(batch.jobs.map((job: { id: number }) => job.id)).toEqual([5, 6]);
  expect(batch.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ novelId: 1, pluginId: "source", priority: "user" })]));
  expect(batch.jobs.every((job: { goal?: boolean }) => job.goal === undefined)).toBe(true);
});


it("queues only published server bodies and persists server-only intent for complete and partial copies", async () => {
  const source = { serverUrl: "https://content.example", workId: "server-work" };
  mocks.serverSource.mockResolvedValue(source);
  mocks.unqueued.mockResolvedValue([chapter(5), chapter(6), chapter(7)]);
  mocks.available.mockResolvedValue({ paths: new Map([["/chapter/5", false]]), numbers: new Map([[6, true]]) });

  await expect(queueChapterDownloadsOnce([1], t, client, { kind: "all" }, { serverOnly: true }))
    .resolves.toEqual({ queued: 2, skippedLocal: 0, skippedServer: 1 });
  expect(mocks.available).toHaveBeenCalledExactlyOnceWith(source);
  const batch = await mocks.submit.mock.calls[0]![0].prepare();
  expect(batch.jobs.map((job: { id: number }) => job.id)).toEqual([5, 6]);
  expect(batch.jobs.every((job: { serverOnly?: boolean }) => job.serverOnly === true)).toBe(true);
});

it("reports metadata-only selections without queueing source downloads", async () => {
  mocks.serverSource.mockResolvedValue({ serverUrl: "https://content.example", workId: "server-work" });
  mocks.unqueued.mockResolvedValue([chapter(5), chapter(6)]);

  const result = await queueChapterDownloadsOnce([1], t, client, { kind: "all" }, { serverOnly: true });
  expect(result).toEqual({ queued: 0, skippedLocal: 0, skippedServer: 2 });
  expect(downloadOnceNotice(t, result)).toEqual({ color: "warn", message: "downloadOnce.serverUnavailable" });
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("keeps server lookup errors out of the source queue", async () => {
  mocks.serverSource.mockResolvedValue({ serverUrl: "https://content.example", workId: "server-work" });
  mocks.unqueued.mockResolvedValue([chapter(5)]);
  mocks.available.mockRejectedValueOnce(new Error("Server offline"));

  await expect(queueChapterDownloadsOnce([1], t, client, { kind: "all" }, { serverOnly: true })).rejects.toThrow("Server offline");
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("does not filter ordinary source requests against content server availability", async () => {
  mocks.unqueued.mockResolvedValue([chapter(5), chapter(6)]);
  await expect(queueChapterDownloadsOnce([1], t, client)).resolves.toEqual({ queued: 2, skippedLocal: 0 });
  expect(mocks.available).not.toHaveBeenCalled();
  expect((await mocks.submit.mock.calls[0]![0].prepare()).jobs.every((job: { serverOnly?: boolean }) => job.serverOnly === undefined)).toBe(true);
});
