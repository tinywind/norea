import { afterEach, expect, it, vi } from "vitest";
import { taskScheduler, type TaskEvent, type TaskRecord } from "./scheduler";
import { beginChapterDownloadQueueWrite, watchChapterDownloadActivity } from "./chapter-download-activity";

vi.mock("./scheduler", () => ({ taskScheduler: {
  getTaskByDedupeKey: vi.fn(),
  subscribeEvents: vi.fn(() => () => undefined),
} }));
afterEach(() => vi.clearAllMocks());

it.each(["chapter.download", "chapter.repairMedia"])("blocks queued and running %s by chapter ID", kind => {
  for (const status of ["queued", "running", "succeeded", "failed", "cancelled"] as const) {
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation(key => key === `${kind}:42`
      ? { status } as TaskRecord : undefined);
    const attempt = watchChapterDownloadActivity(42);
    try { expect(attempt.signal.aborted).toBe(status === "queued" || status === "running"); }
    finally { attempt.dispose(); }
  }
});

it("tracks large pending batches and overlapping writes without losing later reservations", () => {
  vi.mocked(taskScheduler.getTaskByDedupeKey).mockReturnValue(undefined);
  const finishFirst = beginChapterDownloadQueueWrite(Array.from({ length: 20_000 }, (_, i) => i + 1));
  const finishSecond = beginChapterDownloadQueueWrite([20_000]);
  finishFirst();
  const blocked = watchChapterDownloadActivity(20_000);
  expect(blocked.signal.aborted).toBe(true);
  blocked.dispose();
  finishSecond();
  const ready = watchChapterDownloadActivity(20_000);
  expect(ready.signal.aborted).toBe(false);
  ready.dispose();
});

it("remembers a download that starts and finishes during an upload check without blocking other chapters", () => {
  let onEvent!: (event: TaskEvent) => void;
  vi.mocked(taskScheduler.getTaskByDedupeKey).mockReturnValue(undefined);
  vi.mocked(taskScheduler.subscribeEvents).mockImplementationOnce(listener => { onEvent = listener; return () => undefined; });
  const attempt = watchChapterDownloadActivity(42);
  try {
    onEvent({ task: { kind: "chapter.download", subject: { chapterId: 99 }, status: "queued" } as TaskRecord, previousStatus: null });
    expect(attempt.signal.aborted).toBe(false);
    onEvent({ task: { kind: "chapter.repairMedia", subject: { chapterId: 42 }, status: "queued" } as TaskRecord, previousStatus: null });
    onEvent({ task: { kind: "chapter.repairMedia", subject: { chapterId: 42 }, status: "succeeded" } as TaskRecord, previousStatus: "running" });
    expect(attempt.signal.aborted).toBe(true);
  } finally { attempt.dispose(); }
});
