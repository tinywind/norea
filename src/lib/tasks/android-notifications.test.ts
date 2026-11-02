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
import { useNetworkStore } from "../network";

type BrowserEventTarget = "document" | "window";

const listeners = new Map<string, () => void>();
let visibilityState: DocumentVisibilityState;

function eventKey(target: BrowserEventTarget, type: string): string {
  return `${target}:${type}`;
}

function installBrowserHarness(): void {
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(eventKey("document", type), listener);
    },
    get visibilityState() {
      return visibilityState;
    },
    removeEventListener: (type: string) => {
      listeners.delete(eventKey("document", type));
    },
  });
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(eventKey("window", type), listener);
    },
    removeEventListener: (type: string) => {
      listeners.delete(eventKey("window", type));
    },
  });
}

function dispatch(target: BrowserEventTarget, type: string): void {
  listeners.get(eventKey(target, type))?.();
}

function notificationTask(overrides: Record<string, unknown> = {}) {
  return { id: "notification-task", kind: "source.refreshNovel", lane: "source", createdAt: 1,
    priority: "background", status: "running", title: "Metadata", canCancel: true, canRetry: false,
    progress: { current: 0, total: 2 }, ...overrides };
}

beforeEach(() => {
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
