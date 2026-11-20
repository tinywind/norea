import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "./vpn-download-drafts";

const schedulerMocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  setBackgroundExecutionSuspended: vi.fn(),
  requeueRunningInterruptibleDownloads: vi.fn(),
  subscribe: vi.fn(),
  subscribeEvents: vi.fn(),
  yieldRunningInterruptibleDownloads: vi.fn(),
}));

vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => true),
  isTauriRuntime: vi.fn(() => true),
  isWindowsRuntime: vi.fn(() => false),
}));
vi.mock("./scheduler", () => ({
  taskScheduler: schedulerMocks,
}));
const vpnMocks = vi.hoisted(() => ({ getSnapshot: vi.fn(), subscribe: vi.fn() }));
vi.mock("./vpn-download-runtime", () => ({
  getVpnDownloadRuntimeSnapshot: vpnMocks.getSnapshot, subscribeVpnDownloadRuntime: vpnMocks.subscribe,
}));

import {
  startAndroidBackgroundDownloadRecovery,
  startAndroidTaskNotifications,
} from "./android-notifications";
import {
  beginContentSyncRun,
  clearBackgroundSyncFailure,
  isSyncBackgroundExecutionSuspended,
  recordBackgroundSyncFailure,
  resetSyncRuntimeForTests,
  setPendingContentSyncUpload,
} from "./sync-runtime";
import { useNetworkStore } from "../network";

type BrowserEventTarget = "document" | "window";

const listeners = new Map<string, Set<() => void>>();
let visibilityState: DocumentVisibilityState;

function eventKey(target: BrowserEventTarget, type: string): string {
  return `${target}:${type}`;
}

function addListener(target: BrowserEventTarget, type: string, listener: () => void): void {
  const key = eventKey(target, type);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
}

function removeListener(target: BrowserEventTarget, type: string, listener: () => void): void {
  listeners.get(eventKey(target, type))?.delete(listener);
}

function installBrowserHarness(): void {
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: () => void) => {
      addListener("document", type, listener);
    },
    get visibilityState() {
      return visibilityState;
    },
    removeEventListener: (type: string, listener: () => void) => {
      removeListener("document", type, listener);
    },
  });
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: () => void) => {
      addListener("window", type, listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      removeListener("window", type, listener);
    },
  });
}

function dispatch(target: BrowserEventTarget, type: string): void {
  for (const listener of [...(listeners.get(eventKey(target, type)) ?? [])]) {
    listener();
  }
}

function notificationTask(overrides: Record<string, unknown> = {}) {
  return { id: "notification-task", kind: "source.refreshNovel", lane: "source", createdAt: 1,
    priority: "background", status: "running", title: "Metadata", canCancel: true, canRetry: false,
    progress: { current: 0, total: 2 }, ...overrides };
}

beforeEach(() => {
  resetSyncRuntimeForTests();
  useNetworkStore.setState({ connectivity: "online", revision: 1 });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
  vi.clearAllMocks();
  listeners.clear();
  visibilityState = "visible";
  installBrowserHarness();
  schedulerMocks.subscribe.mockReturnValue(vi.fn());
  schedulerMocks.subscribeEvents.mockReturnValue(vi.fn());
  vpnMocks.getSnapshot.mockReturnValue({ plans: [] });
  vpnMocks.subscribe.mockReturnValue(vi.fn());
  schedulerMocks.getSnapshot.mockReturnValue({
    records: [notificationTask()], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false,
  });
});

afterEach(() => {
  resetSyncRuntimeForTests();
  useNetworkStore.setState({ connectivity: "online", revision: 1 });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startAndroidTaskNotifications", () => {
  function runtimeSnapshot(phase: "paused" | "running" | "connecting" = "paused"): VpnDownloadRuntimeSnapshot {
    return {
      drafts: [], loading: false, error: null, chapterLabels: {},
      capabilities: { supported: true, parallelSupported: true, maxWorkers: 2 },
      plans: [{
        id: "plan-a", batchId: "batch-a", pluginId: "source-a", novelId: 1, title: "Work", mode: "parallel",
        policies: { captcha: "pause", cloudflare: "nextProfile" }, createdAt: 1, revision: 1,
        ranges: ["a", "b"].map(id => ({
          id, profileId: `profile-${id}`, profileHash: "hash", startChapterId: 1, endChapterId: 2,
          chapterIds: [1, 2], selectedChapterIds: [1, 2], checkpoint: 0, phase, userPaused: false,
          pauseReason: phase === "paused" ? "challenge-captcha" : null, generation: 5,
          attemptedProfileIds: [], attemptProfileId: null, challenge: { kind: "captcha", url: "https://source.test/chapter" },
        })),
      }],
    };
  }

  it.each(["off", "completion", "progress"] as const)("publishes independent same-source range notices in %s mode", mode => {
    schedulerMocks.getSnapshot.mockReturnValue({ records: [], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false });
    let publish = () => {};
    const unsubscribe = vi.fn();
    vpnMocks.subscribe.mockImplementation(listener => { publish = listener; return unsubscribe; });
    const snapshot = runtimeSnapshot();
    vpnMocks.getSnapshot.mockReturnValue(snapshot);
    const update = vi.fn();
    Object.assign(window, { __NoreaAndroidTasks: { update, stop: vi.fn() } });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop = startAndroidTaskNotifications(t, mode);
    const payload = () => JSON.parse(update.mock.calls.at(-1)![0]);
    expect(payload().ranges.map((item: { rangeId: string }) => item.rangeId)).toEqual(["a", "b"]);
    expect(payload()).toMatchObject({ requestPermission: true, executionActive: false, working: false });
    vpnMocks.getSnapshot.mockReturnValue({ ...snapshot, plans: [{ ...snapshot.plans[0]!, ranges: [snapshot.plans[0]!.ranges[1]!] }] });
    publish(); vi.advanceTimersByTime(250);
    expect(payload().ranges.map((item: { rangeId: string }) => item.rangeId)).toEqual(["b"]);
    stop(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["connecting", "running"] as const)("keeps execution anchored and awake for %s VPN work between chapter tasks", phase => {
    schedulerMocks.getSnapshot.mockReturnValue({ records: [], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false });
    let publish = () => {};
    vpnMocks.subscribe.mockImplementation(listener => { publish = listener; return vi.fn(); });
    vpnMocks.getSnapshot.mockReturnValue(runtimeSnapshot(phase));
    const update = vi.fn();
    Object.assign(window, { __NoreaAndroidTasks: { update, stop: vi.fn() } });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop = startAndroidTaskNotifications(t, "off");
    const payload = () => JSON.parse(update.mock.calls.at(-1)![0]);
    expect(payload()).toMatchObject({ executionActive: true, working: true, ranges: [], groups: [] });
    useNetworkStore.setState({ connectivity: "offline", revision: 2 }); vi.advanceTimersByTime(250);
    expect(payload()).toMatchObject({ executionActive: false, working: false });
    vpnMocks.getSnapshot.mockReturnValue(runtimeSnapshot("paused")); publish(); vi.advanceTimersByTime(250);
    useNetworkStore.setState({ connectivity: "online", revision: 3 }); vi.advanceTimersByTime(250);
    expect(payload()).toMatchObject({ executionActive: false, working: false });
    stop();
  });

  it("keeps presentation alive without restarting execution after platform suspension", () => {
    const update=vi.fn(), stopNative=vi.fn();let blocked=false;
    Object.assign(window,{__NoreaAndroidTasks:{update,stop:stopNative,isExecutionSuspended:()=>blocked}});
    const t=((key:string)=>key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop=startAndroidTaskNotifications(t,"off");
    blocked=true;dispatch("window","norea-background-execution-suspended");
    vi.advanceTimersByTime(250);
    expect(schedulerMocks.setBackgroundExecutionSuspended).toHaveBeenCalledWith(true,"tasks.backgroundExecutionSuspended");
    expect(JSON.parse(update.mock.calls.at(-1)![0]).executionActive).toBe(false);
    dispatch("window","norea-app-resumed");
    expect(JSON.parse(update.mock.calls.at(-1)![0]).executionActive).toBe(false);
    blocked=false;dispatch("window","norea-app-resumed");
    expect(schedulerMocks.setBackgroundExecutionSuspended).toHaveBeenLastCalledWith(false);
    expect(JSON.parse(update.mock.calls.at(-1)![0]).executionActive).toBe(true);
    stop();const count=schedulerMocks.setBackgroundExecutionSuspended.mock.calls.length;
    dispatch("window","norea-background-execution-suspended");
    expect(schedulerMocks.setBackgroundExecutionSuspended).toHaveBeenCalledTimes(count);
  });
  it("detects native suspension after publisher remount",()=>{
    const update=vi.fn();Object.assign(window,{__NoreaAndroidTasks:{update,stop:vi.fn(),isExecutionSuspended:()=>true}});
    const t=((key:string)=>key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop=startAndroidTaskNotifications(t,"off");
    expect(schedulerMocks.setBackgroundExecutionSuspended).toHaveBeenCalledWith(true,"tasks.backgroundExecutionSuspended");
    expect(JSON.parse(update.mock.calls.at(-1)![0]).executionActive).toBe(false);stop();
  });
  it("releases execution while offline and restores it on reconnection",()=>{
    const update=vi.fn();Object.assign(window,{__NoreaAndroidTasks:{update,stop:vi.fn()}});
    const t=((key:string)=>key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop=startAndroidTaskNotifications(t,"off");
    useNetworkStore.setState({connectivity:"offline",revision:2});vi.advanceTimersByTime(250);
    expect(JSON.parse(update.mock.calls.at(-1)![0]).executionActive).toBe(false);
    useNetworkStore.setState({connectivity:"online",revision:3});vi.advanceTimersByTime(250);
    expect(JSON.parse(update.mock.calls.at(-1)![0]).executionActive).toBe(true);stop();
  });
  it("coalesces bursts and suppresses unchanged task data",()=>{
    const update=vi.fn();let emit:(event:never)=>void=()=>{};
    schedulerMocks.subscribeEvents.mockImplementation(listener=>{emit=listener;return vi.fn();});
    Object.assign(window,{__NoreaAndroidTasks:{update,stop:vi.fn()}});
    const t=((key:string)=>key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop=startAndroidTaskNotifications(t,"progress");
    const event={task:notificationTask({progress:{current:1,total:2}}),previousStatus:"running"};
    for(let i=0;i<20;i++)emit(event as never);
    vi.advanceTimersByTime(249);expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);expect(update).toHaveBeenCalledTimes(2);
    for(let i=0;i<20;i++)emit(event as never);
    vi.advanceTimersByTime(250);expect(update).toHaveBeenCalledTimes(2);stop();
  });
  it.each(["off","completion"] as const)("keeps background execution with hidden progress in %s mode",mode=>{
    const update=vi.fn();Object.assign(window,{__NoreaAndroidTasks:{update,stop:vi.fn()}});
    const t=((key:string)=>key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop=startAndroidTaskNotifications(t,mode);
    expect(JSON.parse(update.mock.calls[0]![0])).toMatchObject({quiet:true,executionActive:true,groups:[]});stop();
  });

  it("publishes non-pausable content sync immediately without waking scraper WebViews and keeps LAN sync alive on limited connectivity", () => {
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false,
    });
    const update = vi.fn();
    Object.assign(window, { __NoreaAndroidTasks: { update, stop: vi.fn() } });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop = startAndroidTaskNotifications(t, "progress");
    const latest = () => JSON.parse(update.mock.calls.at(-1)![0]);
    expect(latest()).toMatchObject({ executionActive: false, working: false, requiresScraperWebViews: false, groups: [] });

    const endSync = beginContentSyncRun();
    // Asymmetric 0ms activation publishes immediately without waiting for the 250ms debounce.
    expect(latest()).toMatchObject({
      executionActive: true,
      working: true,
      requiresScraperWebViews: false,
      groups: [expect.objectContaining({ key: "contentSync", pausable: false })],
    });

    // Limited (LAN-only) connectivity keeps content sync anchored while ordinary downloads stay gated on online.
    useNetworkStore.setState({ connectivity: "limited", revision: 2 });
    vi.advanceTimersByTime(250);
    expect(latest()).toMatchObject({ executionActive: true, working: true, requiresScraperWebViews: false });

    endSync();
    // Stop is debounced by 250ms to bridge back-to-back runs.
    expect(latest().executionActive).toBe(true);
    vi.advanceTimersByTime(250);
    expect(latest()).toMatchObject({ executionActive: false, working: false, groups: [] });
    stop();
  });

  it("emits background sync failure completion and cancels it once cleared", () => {
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false,
    });
    const update = vi.fn();
    Object.assign(window, { __NoreaAndroidTasks: { update, stop: vi.fn() } });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop = startAndroidTaskNotifications(t, "completion");
    const latest = () => JSON.parse(update.mock.calls.at(-1)![0]);

    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: "HTTP 403",
      blocked: true,
    });
    expect(latest().completions).toEqual([
      expect.objectContaining({
        key: "contentSync",
        title: "tasks.notification.contentSyncFailed",
        body: "contentSync.blocked",
        action: { type: "openBackupSettings" },
      }),
    ]);

    clearBackgroundSyncFailure("content", "http://server", { force: true });
    expect(latest().cancelledCompletions).toEqual(["contentSync"]);
    stop();
  });

  it("does not replay an already-emitted background sync failure notification across publisher remounts", () => {
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false,
    });
    const update = vi.fn();
    Object.assign(window, { __NoreaAndroidTasks: { update, stop: vi.fn() } });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stopFirst = startAndroidTaskNotifications(t, "progress");

    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: "Failed to fetch",
      blocked: false,
    });
    expect(JSON.parse(update.mock.calls.at(-1)![0]).completions).toHaveLength(1);
    stopFirst();

    update.mockClear();
    const stopSecond = startAndroidTaskNotifications(t, "completion");
    expect(JSON.parse(update.mock.calls.at(-1)![0]).completions).toEqual([]);
    stopSecond();
  });

  it("propagates platform background execution suspension to sync runtime", () => {
    const update = vi.fn();
    let suspended = false;
    Object.assign(window, { __NoreaAndroidTasks: { update, stop: vi.fn(), isExecutionSuspended: () => suspended } });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop = startAndroidTaskNotifications(t, "progress");

    suspended = true;
    dispatch("window", "norea-background-execution-suspended");
    expect(isSyncBackgroundExecutionSuspended()).toBe(true);

    suspended = false;
    dispatch("window", "norea-app-resumed");
    expect(isSyncBackgroundExecutionSuspended()).toBe(false);
    stop();
  });

  it("updates the background failure notification when the newer failure recovers and an older failure remains active", () => {
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false,
    });
    const update = vi.fn();
    Object.assign(window, { __NoreaAndroidTasks: { update, stop: vi.fn() } });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop = startAndroidTaskNotifications(t, "completion");
    const latest = () => JSON.parse(update.mock.calls.at(-1)![0]);

    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: "Content upload timed out",
      blocked: false,
    });
    recordBackgroundSyncFailure({
      kind: "userState",
      serverUrl: "http://server",
      rawError: "HTTP 403",
      blocked: true,
    });
    expect(latest().completions).toEqual([
      expect.objectContaining({ key: "contentSync", body: "contentSync.blocked" }),
    ]);

    clearBackgroundSyncFailure("userState", "http://server", { force: true });
    expect(latest().completions).toEqual([
      expect.objectContaining({
        key: "contentSync",
        title: "tasks.notification.contentSyncFailed",
        body: "contentSync.error.timeout",
        action: { type: "openBackupSettings" },
      }),
    ]);
    expect(latest().cancelledCompletions).toBeUndefined();
    stop();
  });

  it("publishes pending upload hint before download completion and activates content sync immediately for FGS handoff", () => {
    let emitSnapshot = () => {};
    let emitEvent: (event: never) => void = () => {};
    const download = notificationTask({ id: "dl-1", kind: "chapter.download", status: "running" });
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [download], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false,
    });
    schedulerMocks.subscribe.mockImplementation(listener => { emitSnapshot = listener; return vi.fn(); });
    schedulerMocks.subscribeEvents.mockImplementation(listener => { emitEvent = listener; return vi.fn(); });

    const update = vi.fn();
    const setPendingBackgroundUpload = vi.fn();
    Object.assign(window, {
      __NoreaAndroidTasks: { update, stop: vi.fn(), setPendingBackgroundUpload },
    });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop = startAndroidTaskNotifications(t, "progress");
    const latest = () => JSON.parse(update.mock.calls.at(-1)![0]);
    expect(latest()).toMatchObject({ executionActive: true, requiresScraperWebViews: true });

    // Local content sync upload is queued before the download finishes.
    setPendingContentSyncUpload(true);
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(true);

    // Download completes; JS sends executionActive=false while native keeps the handoff anchor alive.
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [{ ...download, status: "succeeded" }],
      sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false,
    });
    emitEvent({ task: { ...download, status: "succeeded" }, previousStatus: "running" } as never);
    emitSnapshot();
    vi.advanceTimersByTime(250);
    expect(latest()).toMatchObject({ executionActive: false, working: false, requiresScraperWebViews: false });
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(true);

    // Once content sync starts after debounce/IPC, JS immediately publishes executionActive=true at 0ms.
    const endSync = beginContentSyncRun();
    expect(latest()).toMatchObject({
      executionActive: true,
      working: true,
      requiresScraperWebViews: false,
      syncQuietAnchor: true,
      groups: [expect.objectContaining({ key: "contentSync", pausable: false })],
    });
    setPendingContentSyncUpload(false);
    endSync();
    vi.advanceTimersByTime(250);
    expect(latest()).toMatchObject({ executionActive: false, working: false, groups: [] });
    expect(latest().syncQuietAnchor).toBeUndefined();
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(false);
    stop();
  });

  it.each(["off", "completion"] as const)("keeps syncQuietAnchor enabled during sync-only quiet execution in %s mode", (mode) => {
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [], sourceAccessBlocks: [], pausedTaskGroups: [], sourceQueuesPaused: false,
    });
    const update = vi.fn();
    Object.assign(window, { __NoreaAndroidTasks: { update, stop: vi.fn() } });
    const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
    const stop = startAndroidTaskNotifications(t, mode);
    const latest = () => JSON.parse(update.mock.calls.at(-1)![0]);

    const endSync = beginContentSyncRun();
    expect(latest()).toMatchObject({
      quiet: true,
      executionActive: true,
      working: true,
      requiresScraperWebViews: false,
      syncQuietAnchor: true,
      groups: [],
    });
    endSync();
    stop();
  });
});

describe("startAndroidBackgroundDownloadRecovery", () => {
  it("asks running background downloads to yield after returning to foreground", () => {
    schedulerMocks.getSnapshot.mockReturnValue({ records: [notificationTask({kind: "chapter.download"})] });
    const stop = startAndroidBackgroundDownloadRecovery();

    visibilityState = "hidden";
    dispatch("document", "visibilitychange");
    vi.advanceTimersByTime(15_000);
    visibilityState = "visible";
    dispatch("document", "visibilitychange");

    expect(
      schedulerMocks.yieldRunningInterruptibleDownloads,
    ).toHaveBeenCalledTimes(1);
    expect(
      schedulerMocks.requeueRunningInterruptibleDownloads,
    ).not.toHaveBeenCalled();

    stop();
  });

  it("also yields a user-started download after app backgrounding", () => {
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [
        {
          kind: "chapter.download",
          priority: "interactive",
          status: "running",
        },
      ],
    });
    const stop = startAndroidBackgroundDownloadRecovery();

    visibilityState = "hidden";
    dispatch("document", "visibilitychange");
    vi.advanceTimersByTime(15_000);
    visibilityState = "visible";
    dispatch("document", "visibilitychange");

    expect(
      schedulerMocks.yieldRunningInterruptibleDownloads,
    ).toHaveBeenCalledTimes(1);

    stop();
  });
});
