import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskEvent, TaskRecord, TaskSnapshot, SourceAccessBlock } from "../lib/tasks/scheduler";
import type { ChapterDownloadBatchProgressEvent } from "../lib/tasks/chapter-download";
import type { TaskNotificationAction } from "../lib/tasks/native-notification-actions";
import type { TaskNotificationMode } from "../store/notifications";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined), listen: vi.fn(),
  getSnapshot: vi.fn(), subscribe: vi.fn(), subscribeEvents: vi.fn(), subscribeBatches: vi.fn(),
  navigate: vi.fn(), show: vi.fn().mockResolvedValue(undefined),
  unminimize: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined),
  unlisten: vi.fn(),
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(), useEffect: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../lib/tauri-runtime", () => ({ isWindowsRuntime: () => true }));
vi.mock("../lib/tasks/scheduler", () => ({ taskScheduler: mocks }));
vi.mock("../lib/tasks/chapter-download", () => ({
  getChapterDownloadBatchProgress: () => [],
  subscribeChapterDownloadBatchProgress: mocks.subscribeBatches,
}));
vi.mock("../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key === "tasks.notification.downloadTitleProgress"
        ? `${params?.current}/${params?.total} processed`
        : key === "tasks.notification.results"
          ? `${params?.succeeded} succeeded, ${params?.failed} failed, ${params?.cancelled} cancelled`
          : key,
  }),
}));

import { WindowsTaskNotificationBridge } from "./WindowsTaskNotificationBridge";

interface NativePayload {
  groups: Array<{ key: string; body: string; paused: boolean; pauseLabel: string; resumeLabel: string }>;
  challenges: Array<{ sourceId: string; scopeKey: string; revision: number }>;
  completions: Array<{ key: string; body: string }>;
  quiet: boolean;
}
let emit: (event: TaskEvent) => void;
let emitBatch: (event: ChapterDownloadBatchProgressEvent) => void;
let publish: () => void;
let receiveAction: (event: { payload: unknown }) => void;
let dispose: (() => void) | undefined;

function task(id: string, kind: TaskRecord["kind"] = "chapter.download"): TaskRecord {
  return {
    id, kind, lane: "source", priority: "background", title: id,
    source: { id: "source-a", name: "Source A" }, status: "queued",
    createdAt: 1, canCancel: true, canRetry: false,
  };
}
function block(sourceId: string): SourceAccessBlock {
  return {
    sourceId, scopeKey: `plugin:${sourceId}:site:source.test`, revision: 1,
    detectedAt: 1, verificationRequested: false,
    challenge: { kind: "captcha", url: "https://source.test/chapter/1" },
  };
}
function snapshot(records: TaskRecord[] = [], patch: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    records, pausedSourceIds: [], pausedTaskGroups: [], sourceQueueOrder: [],
    recordLimit: records.length, recordsTruncated: false, sourceQueueLimit: 0,
    sourceQueuesTotal: 0, sourceQueuesTruncated: false, sourceQueuesPaused: false,
    sourceAccessBlocks: [], total: records.length, running: 0, queued: records.length,
    failed: 0, succeeded: 0, cancelled: 0, ...patch,
  };
}
function payload(): NativePayload {
  return mocks.invoke.mock.calls.filter(([command]) => command === "task_notification_reconcile").at(-1)?.[1].payload;
}
async function mount(mode: TaskNotificationMode, onAction?: (action: TaskNotificationAction) => void) {
  WindowsTaskNotificationBridge({ taskProgressMode: mode, onAction });
  const cleanup = vi.mocked(useEffect).mock.calls.at(-1)![0]();
  if (typeof cleanup === "function") dispose = cleanup;
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  emit = () => undefined; emitBatch = () => undefined;
  publish = () => undefined; receiveAction = () => undefined;
  mocks.getSnapshot.mockReturnValue(snapshot());
  mocks.listen.mockImplementation(async (_event: string, listener: typeof receiveAction) => {
    receiveAction = listener; return mocks.unlisten;
  });
  mocks.subscribe.mockImplementation((listener: () => void) => { publish = listener; return vi.fn(); });
  mocks.subscribeEvents.mockImplementation((listener: typeof emit) => { emit = listener; return vi.fn(); });
  mocks.subscribeBatches.mockImplementation((listener: typeof emitBatch) => { emitBatch = listener; return vi.fn(); });
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); });

it("publishes distinct task groups with independent pause state", async () => {
  mocks.getSnapshot.mockReturnValue(snapshot([task("download"), task("metadata", "source.refreshNovel")]));
  await mount("progress");
  expect(payload().groups.map(group => group.key)).toEqual(["downloads", "libraryMetadata"]);
  expect(payload().groups.every(group => group.pauseLabel && group.resumeLabel)).toBe(true);

  mocks.getSnapshot.mockReturnValue(snapshot([], { pausedTaskGroups: ["downloads"] }));
  publish(); await vi.advanceTimersByTimeAsync(250);

  expect(payload().groups).toMatchObject([
    { key: "downloads", paused: true }, { key: "libraryMetadata", paused: false },
  ]);
});

it.each(["off", "completion"] as const)("keeps per-plugin verification independent of %s progress mode", async mode => {
  mocks.getSnapshot.mockReturnValue(snapshot([task("download")], { sourceAccessBlocks: [block("source-a"), block("source-b")] }));
  await mount(mode);
  expect(payload().groups).toEqual([]);
  expect(payload().challenges.map(challenge => challenge.sourceId)).toEqual(["source-a", "source-b"]);

  mocks.getSnapshot.mockReturnValue(snapshot([], { sourceAccessBlocks: [block("source-b")] }));
  publish(); await vi.advanceTimersByTimeAsync(250);

  expect(payload().challenges.map(challenge => challenge.sourceId)).toEqual(["source-b"]);
});

it.each(["off", "completion", "progress"] as const)("publishes terminal results according to %s mode without replay", async mode => {
  const download = task("download");
  mocks.getSnapshot.mockReturnValue(snapshot([download]));
  await mount(mode);
  emit({ task: { ...download, status: "succeeded" }, previousStatus: "queued" });
  publish(); await vi.advanceTimersByTimeAsync(250);
  expect(payload().completions).toEqual(mode === "off" ? [] : [expect.objectContaining({ key: "downloads" })]);

  const calls = mocks.invoke.mock.calls.length;
  publish(); await vi.advanceTimersByTimeAsync(250);
  expect(mocks.invoke.mock.calls.length).toBe(calls);
});

it("receives batch work before any scheduler child is materialized", async () => {
  await mount("progress");
  emitBatch({
    batchId: "batch", active: true,
    progress: { current: 2, total: 4, succeeded: 2, failed: 0, cancelled: 0 },
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(payload().groups).toMatchObject([{ key: "downloads", body: "2/4 processed" }]);
});

it.each([false, true])("updates the tracker without rescanning later materialized records (orphaned challenge: %s)", async orphaned => {
  const first = task("first");
  const blocked = orphaned ? [block("orphaned-source")] : [];
  mocks.getSnapshot.mockReturnValue(snapshot([first, task("second")], {sourceAccessBlocks:blocked}));
  await mount("progress");
  const metadata = snapshot([], {sourceAccessBlocks:blocked});
  Object.defineProperty(metadata, "records", { get: () => { throw new Error("Full records rescanned"); } });
  mocks.getSnapshot.mockReturnValue(metadata);

  emit({ task: { ...first, status: "succeeded" }, previousStatus: "queued" });
  publish(); await vi.advanceTimersByTimeAsync(250);

  expect(payload().groups).toMatchObject([{ key: "downloads", body: "1/2 processed" }]);
});

it("routes validated native actions and ignores executable or malformed input", async () => {
  const onAction = vi.fn();
  await mount("off", onAction);
  receiveAction({ payload: { type: "pause", groupKey: "downloads" } });
  receiveAction({ payload: { type: "resume", groupKey: "libraryMetadata" } });
  receiveAction({ payload: { type: "openTasks" } });
  receiveAction({ payload: { type: "verifySource", sourceId: "source-a", scopeKey: block("source-a").scopeKey, revision: 1 } });
  receiveAction({ payload: { type: "runScript", script: "bad" } });
  receiveAction({ payload: { type: "pause", groupKey: "unknown" } });
  await vi.advanceTimersByTimeAsync(0);

  expect(onAction.mock.calls.map(([action]) => action.type)).toEqual(["pause", "resume", "openTasks", "verifySource"]);
  expect(mocks.show).toHaveBeenCalledTimes(2);
});

it("throttles small progress changes and eventually publishes the newest counts", async () => {
  await mount("progress");
  const progress = { current: 0, total: 100, succeeded: 0, failed: 0, cancelled: 0 };
  emitBatch({ batchId: "batch", active: true, progress });
  await vi.advanceTimersByTimeAsync(250);
  const calls = mocks.invoke.mock.calls.length;

  emitBatch({ batchId: "batch", active: true, progress: { ...progress, current: 5, succeeded: 5 } });
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.invoke).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(2250);

  expect(mocks.invoke).toHaveBeenCalledTimes(calls + 1);
  expect(payload().groups).toMatchObject([{ key: "downloads", body: "5/100 processed" }]);
});

it("publishes a meaningful progress step before the regular interval", async () => {
  await mount("progress");
  const progress = { current: 0, total: 100, succeeded: 0, failed: 0, cancelled: 0 };
  emitBatch({ batchId: "batch", active: true, progress });
  await vi.advanceTimersByTimeAsync(250);
  const calls = mocks.invoke.mock.calls.length;

  emitBatch({ batchId: "batch", active: true, progress: { ...progress, current: 12, succeeded: 12 } });
  await vi.advanceTimersByTimeAsync(250);

  expect(mocks.invoke).toHaveBeenCalledTimes(calls + 1);
  expect(payload().groups).toMatchObject([{ key: "downloads", body: "12/100 processed" }]);
});

it("retains terminal results when native reconciliation fails", async () => {
  const download = task("download");
  mocks.getSnapshot.mockReturnValue(snapshot([download]));
  await mount("completion");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.invoke.mockRejectedValueOnce(new Error("Native send failed"));
  emit({ task: { ...download, status: "succeeded" }, previousStatus: "queued" });
  publish(); await vi.advanceTimersByTimeAsync(250);

  publish(); await vi.advanceTimersByTimeAsync(250);

  expect(payload().completions).toMatchObject([{ key: "downloads" }]);
  warn.mockRestore();
});

it("coalesces a failed result and a later result from the same group before retry", async () => {
  const first = task("first");
  mocks.getSnapshot.mockReturnValue(snapshot([first]));
  await mount("completion");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.invoke.mockRejectedValueOnce(new Error("Native send failed"));
  emit({ task: { ...first, status: "succeeded" }, previousStatus: "queued" });
  publish(); await vi.advanceTimersByTimeAsync(250);

  const next = task("next");
  emit({ task: next, previousStatus: null });
  emit({ task: { ...next, status: "failed" }, previousStatus: "queued" });
  mocks.getSnapshot.mockReturnValue(snapshot([], { sourceAccessBlocks: [block("source-b")] }));
  publish(); await vi.advanceTimersByTimeAsync(250);

  expect(payload().completions).toEqual([
    expect.objectContaining({ key: "downloads", body: "0 succeeded, 1 failed, 0 cancelled" }),
  ]);
  expect(payload().challenges).toMatchObject([{ sourceId: "source-b" }]);
  warn.mockRestore();
});

it("preserves a newer same-group result while an earlier reconciliation is still pending", async () => {
  const first = task("first");
  mocks.getSnapshot.mockReturnValue(snapshot([first]));
  await mount("completion");
  let complete!: () => void;
  mocks.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  emit({ task: { ...first, status: "succeeded" }, previousStatus: "queued" });
  publish(); await vi.advanceTimersByTimeAsync(250);

  const next = task("next");
  emit({ task: next, previousStatus: null });
  emit({ task: { ...next, status: "failed" }, previousStatus: "queued" });
  publish(); await vi.advanceTimersByTimeAsync(250);
  complete(); await vi.advanceTimersByTimeAsync(0);

  expect(payload().completions).toEqual([
    expect.objectContaining({ key: "downloads", body: "0 succeeded, 1 failed, 0 cancelled" }),
  ]);
});

it.each(["challenge", "paused"] as const)("retries a failed static %s snapshot without another task event", async state => {
  mocks.getSnapshot.mockReturnValue(state === "challenge"
    ? snapshot([], { sourceAccessBlocks: [block("source-a")] })
    : snapshot([task("download")], { pausedTaskGroups: ["downloads"] }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.invoke.mockRejectedValueOnce(new Error("Native send failed"));
  await mount(state === "challenge" ? "off" : "progress");
  const firstPayload = payload();

  await vi.advanceTimersByTimeAsync(2499);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(payload()).toEqual(firstPayload);
  warn.mockRestore();
});

it("unregisters an action listener that finishes registering after cleanup", async () => {
  let registered!: (unlisten: () => void) => void;
  mocks.listen.mockImplementationOnce(() => new Promise(resolve => { registered = resolve; }));
  await mount("off");
  dispose?.(); dispose = undefined;
  const calls = mocks.invoke.mock.calls.length;

  registered(mocks.unlisten);
  await vi.advanceTimersByTimeAsync(0);

  expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledTimes(calls);
});

it("opens the download queue when no parent action handler is provided", async () => {
  await mount("off");
  receiveAction({ payload: { type: "openTasks" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/downloads", search: { view: "queue" } });
});
