import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("../tauri-runtime", () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock("../../db/queries/chapter", () => ({
  getChapterById: vi.fn(() => new Promise(() => undefined)),
  listExistingChapterIds: vi.fn(async (ids: number[]) => ids),
  markChapterMediaRepairPending: vi.fn(),
}));
vi.mock("../../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("../../db/work-metadata", () => ({ refreshStoredNovelChapterDownloads: vi.fn() }));
vi.mock("../../db/queries/chapter-download-queue", () => ({
  listOrdinaryChapterDownloadJobs: vi.fn(async () => []),
  adoptOrdinaryChapterDownloadJobs: vi.fn(async () => []),
}));
vi.mock("../../store/browse", () => ({
  useBrowseStore: { getState: vi.fn(() => ({ chapterDownloadCooldownSeconds: 0 })) },
}));
vi.mock("./chapter-download-failures", () => ({
  recordFailedChapterDownloadAttempt: vi.fn(async () => null),
  forgetChapterDownloadFailures: vi.fn(async () => undefined),
  refreshChapterDownloadFailures: vi.fn(async () => undefined),
  getChapterDownloadFailureSnapshot: vi.fn(() => []),
}));
vi.mock("./chapter-storage-operation", () => ({
  runExclusiveChapterStorageOperation: vi.fn(),
  waitForChapterStorageOperation: vi.fn(() => new Promise(() => undefined)),
}));

import { adoptOrdinaryChapterDownloadJobs, listOrdinaryChapterDownloadJobs } from "../../db/queries/chapter-download-queue";
import { beginChapterDownloadVpnHandover, type ChapterDownloadJob } from "./chapter-download";
import { getChapterDownloadRequestSnapshot, submitChapterDownloadRequest } from "./chapter-download-requests";
import { taskScheduler } from "./scheduler";

const CHAPTERS = 2_000;
const NOVEL_ID = 77;

function jobs(firstId = 50_000, count = CHAPTERS): ChapterDownloadJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    pluginId: "admission-source",
    chapterPath: `/chapter/${firstId + index}`,
    chapterName: `Chapter ${index}`,
    novelId: NOVEL_ID,
    novelName: "Long work",
    novelPath: "/novel/long",
    priority: "user" as const,
    title: `Chapter ${index}`,
  }));
}

function workRecords() {
  return taskScheduler.getSnapshot().records
    .filter(record => record.kind === "chapter.download" && record.subject?.novelId === NOVEL_ID &&
      (record.status === "queued" || record.status === "running"));
}

function enqueueCommands(): unknown[][] {
  return tauriMocks.invoke.mock.calls.filter(([command]) => command === "chapter_download_queue_enqueue");
}

function submit(key: string, batch: ChapterDownloadJob[]) {
  return submitChapterDownloadRequest({
    key, title: "Long work", novelIds: [NOVEL_ID], total: batch.length,
    prepare: async () => ({ jobs: batch, materializeAllTasks: true, title: "Long work", total: batch.length }),
  });
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockImplementation(async () => undefined);
});

afterEach(() => {
  taskScheduler.cancelActiveTasks({ discardQueued: true });
});

it("accepts a 2,000-chapter selection as one scheduler publication and one queue write", async () => {
  let snapshotNotifications = 0;
  const unsubscribe = taskScheduler.subscribe(() => { snapshotNotifications += 1; });
  const started = performance.now();
  const handle = submit("admission", jobs());
  expect(getChapterDownloadRequestSnapshot()).toEqual([expect.objectContaining({ id: handle.id, total: CHAPTERS })]);

  await handle.materialized;
  const elapsed = performance.now() - started;
  unsubscribe();

  expect(workRecords()).toHaveLength(CHAPTERS);
  expect(new Set(workRecords().map(record => record.subject?.batchId)).size).toBe(1);
  expect(enqueueCommands()).toHaveLength(1);
  expect((enqueueCommands()[0]![1] as { jobs: unknown[] }).jobs).toHaveLength(CHAPTERS);
  expect(snapshotNotifications).toBeLessThanOrEqual(2);
  expect(workRecords().filter(record => record.status === "running").length).toBeLessThanOrEqual(3);
  expect(elapsed).toBeLessThan(1_000);
});

it("shows every selected chapter while the persistent queue write is still pending", async () => {
  let releaseWrite!: () => void;
  const write = new Promise<void>((resolve) => { releaseWrite = resolve; });
  tauriMocks.invoke.mockImplementation(async (command: string) => {
    if (command === "chapter_download_queue_enqueue") await write;
  });
  const handle = submit("held-write", jobs());
  let materialized = false;
  void handle.materialized.then(() => { materialized = true; });
  for (let step = 0; step < 5; step += 1) await Promise.resolve();

  expect(workRecords()).toHaveLength(CHAPTERS);
  expect(materialized).toBe(false);
  expect(getChapterDownloadRequestSnapshot()).toEqual([
    expect.objectContaining({ id: handle.id, phase: "publishing", total: CHAPTERS }),
  ]);

  releaseWrite();
  await handle.materialized;
  expect(getChapterDownloadRequestSnapshot()).toEqual([]);
});

it("keeps one task per chapter when an overlapping request arrives", async () => {
  await submit("first", jobs(60_000, 1_000)).materialized;
  await submit("overlap", jobs(60_500, 1_000)).materialized;

  const chapterIds = workRecords().map(record => record.subject?.chapterId);
  expect(chapterIds).toHaveLength(1_500);
  expect(new Set(chapterIds).size).toBe(1_500);
  const queued = enqueueCommands().map(([, args]) => (args as { jobs: { id: number }[] }).jobs.map(job => job.id));
  expect(queued[1]).toHaveLength(500);
  expect(Math.min(...queued[1]!)).toBe(61_000);
});

it("offers the whole accepted selection to a VPN handover at once", async () => {
  const batch = jobs(70_000, CHAPTERS);
  await submit("handover", batch).materialized;
  vi.mocked(listOrdinaryChapterDownloadJobs).mockResolvedValue(
    batch.map(job => ({ job, jobJson: JSON.stringify(job), updatedAtMs: 1 })),
  );
  vi.mocked(adoptOrdinaryChapterDownloadJobs).mockImplementation(async (_batchId, claim) => claim.map(row => row.job));

  const handover = await beginChapterDownloadVpnHandover();
  const adopted = await handover.commitReady("vpn-run");
  handover.release();

  expect(handover.jobs).toHaveLength(CHAPTERS);
  expect(adopted).toHaveLength(CHAPTERS - handover.pending.length);
  expect(workRecords().filter(record => record.status === "queued")).toHaveLength(0);
});
