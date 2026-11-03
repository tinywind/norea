import { useEffect, type ReactElement } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import * as chapterDownloads from "../lib/tasks/chapter-download";
import * as chapterQueries from "../db/queries/chapter";
import { notifications, notificationsStore } from "@mantine/notifications";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskScheduler } from "../lib/tasks/scheduler";
import type { SourceAccessBlock } from "../lib/tasks/scheduler";
import * as sourceAccessCoordinator from "../lib/tasks/source-access-coordinator";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "../lib/tasks/vpn-download-types";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import { TaskNotifications } from "./TaskNotifications";

const vpnMocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(), subscribe: vi.fn(),
  initialize: vi.fn(async () => undefined), open: vi.fn(async () => undefined), navigate: vi.fn(),
}));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({
  getVpnDownloadRuntimeSnapshot: vpnMocks.getSnapshot,
  subscribeVpnDownloadRuntime: vpnMocks.subscribe,
  initializeVpnDownloadRuntime: vpnMocks.initialize,
  openVpnDownloadVerification: vpnMocks.open,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueryClient: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vpnMocks.navigate }));

vi.mock("../i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../store/notifications", () => ({
  useNotificationStore: () => "none",
}));

describe("download completion notifications", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it("reports queue restoration errors and retries when the application resumes", () => {
    const client = new QueryClient();
    vi.mocked(useQueryClient).mockReturnValue(client);
    const restore = vi.spyOn(chapterDownloads, "startChapterDownloadQueueExecutor")
      .mockImplementation(() => {});
    vi.stubGlobal("window", new EventTarget());
    TaskNotifications();
    const dispose = vi.mocked(useEffect).mock.calls[0]![0]() as () => void;
    try {
      expect(restore).toHaveBeenCalledOnce();
      const onError = restore.mock.calls[0]![0];
      expect(onError).toBeTypeOf("function");
      onError!(new Error("Download queue database is busy"));
      expect(notificationsStore.getState().notifications[0]).toMatchObject({
        autoClose: 5_000,
        title: "tasks.restoreQueueFailed",
        message: "Download queue database is busy",
      });
      window.dispatchEvent(new Event("norea-app-resumed"));
      expect(restore).toHaveBeenCalledTimes(2);
      expect(notificationsStore.getState().notifications).toEqual([]);
      dispose();
      window.dispatchEvent(new Event("norea-app-resumed"));
      expect(restore).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      notifications.clean();
      client.clear();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])("keeps work metadata cached after completion (batch: %s)", async (batch) => {
    const client = new QueryClient();
    const metadataKey = ["novel", "detail", 7];
    client.setQueryData(metadataKey, { name: "Book", cover: "cover.webp" });
    client.setQueryData([...metadataKey, "chapters"], [{ id: 11, isDownloaded: false }]);
    const installedDownload = {
      isDownloaded: true, mediaRepairNeeded: false, contentBytes: 120,
      mediaBytes: 30, contentType: "html",
    } as const;
    vi.spyOn(chapterQueries, "getChapterById").mockResolvedValue({
      id: 11, ...installedDownload,
    } as chapterQueries.ChapterRow);
    vi.mocked(useQueryClient).mockReturnValue(client);
    let completion!: Parameters<typeof chapterDownloads.subscribeChapterDownloads>[0];
    let batchSettled!: () => void;
    vi.spyOn(chapterDownloads, "subscribeChapterDownloads").mockImplementation(listener => { completion = listener; return () => {}; });
    vi.spyOn(chapterDownloads, "subscribeChapterDownloadBatchesSettled").mockImplementation(listener => { batchSettled = () => listener("batch"); return () => {}; });
    vi.spyOn(chapterDownloads, "startChapterDownloadQueueExecutor").mockImplementation(() => {});
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    TaskNotifications();
    const dispose = vi.mocked(useEffect).mock.calls[0]![0]() as () => void;
    try {
      completion({ job: { id: 11, novelId: 7, ...(batch ? { batchId: "batch" } : {}) }, status: { kind: "done" } } as Parameters<typeof completion>[0]);
      if (batch) batchSettled();
      await vi.waitFor(() => expect(client.getQueryData([...metadataKey, "chapters"])).toEqual([{ id: 11, ...installedDownload }]));
      expect(client.getQueryState(metadataKey)?.isInvalidated).toBe(false);
    } finally {
      dispose(); client.clear(); vi.unstubAllGlobals();
    }
  });
});

function accessBlock(): SourceAccessBlock {
  return {
    challenge: {
      kind: "captcha",
      url: "https://source.test/chapter/1",
    },
    detectedAt: 1,
    revision: 1,
    scopeKey: "plugin:source-a:site:source.test",
    sourceId: "source-a",
    verificationRequested: false,
  };
}

describe("per-plugin source access notifications", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => { dispose?.(); dispose=undefined; notifications.clean(); vi.restoreAllMocks(); vi.clearAllMocks(); });
  function mount(blocks: SourceAccessBlock[]) {
    let current=blocks;
    let sync=()=>{};
    vi.mocked(useQueryClient).mockReturnValue(new QueryClient());
    vi.spyOn(chapterDownloads,"startChapterDownloadQueueExecutor").mockImplementation(()=>{});
    const baseSnapshot = taskScheduler.getSnapshot();
    vi.spyOn(taskScheduler,"getSnapshot").mockImplementation(()=>({ ...baseSnapshot, records:[],sourceAccessBlocks:current }));
    vi.spyOn(taskScheduler,"subscribe").mockImplementation(listener=>{sync=listener;return ()=>{};});
    TaskNotifications();
    dispose=vi.mocked(useEffect).mock.calls[1]![0]() as ()=>void;
    return (next: SourceAccessBlock[])=>{current=next;sync();};
  }
  it("shows separate notices and does not open the verification browser automatically",()=>{
    const open=vi.spyOn(sourceAccessCoordinator,"openSourceAccessBrowser").mockResolvedValue(true);
    const a=accessBlock();
    const b={...a,sourceId:"source-b",scopeKey:"plugin:source-b:site:source.test"};
    mount([a,b]);
    expect(notificationsStore.getState().notifications.map(item=>item.id)).toEqual(["source-access-required:source-a","source-access-required:source-b"]);
    expect(open).not.toHaveBeenCalled();
  });
  it("removes only a resolved plugin notice",()=>{
    const a=accessBlock();
    const b={...a,sourceId:"source-b",scopeKey:"plugin:source-b:site:source.test"};
    const sync=mount([a,b]);sync([b]);
    expect(notificationsStore.getState().notifications.map(item=>item.id)).toEqual(["source-access-required:source-b"]);
  });
  it("preserves dismissal until the challenge identity changes",()=>{
    const a=accessBlock();const sync=mount([a]);
    const notice = notificationsStore.getState().notifications[0]!;
    expect(notice.autoClose).toBe(false);
    const action = (notice.message as ReactElement<{ children: unknown[] }>).props.children.at(-1) as ReactElement<{ size?: string }>;
    expect(action.props.size).toBeUndefined();
    notifications.hide("source-access-required:source-a");sync([{...a}]);
    expect(notificationsStore.getState().notifications).toEqual([]);
    sync([{...a,revision:2}]);
    expect(notificationsStore.getState().notifications).toHaveLength(1);
  });
  it("does not update an unchanged notice on unrelated scheduler snapshots",()=>{
    const a=accessBlock();const sync=mount([a]);const update=vi.spyOn(notifications,"update");
    sync([{...a}]);sync([{...a}]);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("per-range VPN notifications", () => {
  let dispose: (() => void) | undefined;
  let client: QueryClient;
  afterEach(() => {
    dispose?.(); dispose = undefined;
    notifications.clean(); client?.clear(); vi.restoreAllMocks(); vi.clearAllMocks();
  });

  function range(id: string, patch: Partial<VpnDownloadRangeState> = {}): VpnDownloadRangeState {
    const chapterIds = id === "b" ? [3, 4] : [1, 2];
    return {
      id, profileId: `profile-${id}`, profileHash: "hash", startChapterId: chapterIds[0]!, endChapterId: chapterIds[1]!,
      chapterIds, selectedChapterIds: [...chapterIds], checkpoint: 0, phase: "paused", userPaused: false,
      pauseReason: "challenge-captcha", attemptedProfileIds: [`profile-${id}`], attemptProfileId: null, generation: 7,
      challenge: { kind: "captcha", url: "https://source.test/chapter" }, ...patch,
    };
  }
  function plan(ranges: VpnDownloadRangeState[], id = "plan-a"): VpnDownloadPlan {
    return { id, batchId: `batch-${id}`, pluginId: "source-a", novelId: 1, title: "Work", mode: "parallel", createdAt: 1, revision: 1,
      policies: { captcha: "pause", cloudflare: "nextProfile" }, ranges };
  }
  function mount(plans: VpnDownloadPlan[]) {
    let current: VpnDownloadRuntimeSnapshot = {
      drafts: [], plans, loading: false, error: null, chapterLabels: {},
      capabilities: { supported: true, parallelSupported: true, maxWorkers: 2 },
    };
    let sync = () => {};
    const unsubscribe = vi.fn();
    client = new QueryClient(); vi.mocked(useQueryClient).mockReturnValue(client);
    vpnMocks.getSnapshot.mockImplementation(() => current);
    vpnMocks.subscribe.mockImplementation(listener => { sync = listener; return unsubscribe; });
    TaskNotifications();
    dispose = vi.mocked(useEffect).mock.calls.at(-1)![0]() as () => void;
    return {
      unsubscribe,
      update(next: VpnDownloadPlan[]) { current = { ...current, plans: next }; sync(); },
    };
  }
  const id = (range: string, plan = "plan-a") => `vpn-download-required:["${plan}","${range}"]`;
  function actionButton(notificationId: string): ReactElement<{ onClick: () => void }> {
    const item = notificationsStore.getState().notifications.find(item => item.id === notificationId)!;
    const message = item.message as ReactElement<{ children: unknown[] }>;
    return message.props.children.at(-1) as ReactElement<{ onClick: () => void }>;
  }

  it("keeps the sibling notice after one same-source range completes its whole chapter", () => {
    const a = range("a"), b = range("b");
    const sync = mount([plan([a, b])]);
    expect(notificationsStore.getState().notifications.map(item => item.id)).toEqual([id("a"), id("b")]);
    const sibling = notificationsStore.getState().notifications[1];
    sync.update([plan([{ ...a, checkpoint: 1, phase: "running", challenge: null, pauseReason: null }, b])]);
    expect(notificationsStore.getState().notifications).toEqual([sibling]);
    expect(vpnMocks.open).not.toHaveBeenCalled();
  });

  it("opens only the exact range owner and rejects its old action after a generation change", async () => {
    const a = range("a"); const sync = mount([plan([a])]);
    const original = actionButton(id("a"));
    original.props.onClick();
    await vi.waitFor(() => expect(vpnMocks.open).toHaveBeenCalledWith("plan-a", "a"));
    vpnMocks.open.mockClear();
    sync.update([plan([{ ...a, generation: 8, profileId: "replacement" }])]);
    original.props.onClick();
    await vi.waitFor(() => expect(vpnMocks.initialize).toHaveBeenCalledTimes(2));
    expect(vpnMocks.open).not.toHaveBeenCalled();
    actionButton(id("a")).props.onClick();
    await vi.waitFor(() => expect(vpnMocks.open).toHaveBeenCalledWith("plan-a", "a"));
  });

  it("navigates to Tasks for exhaustion without reconnecting or opening a browser", async () => {
    mount([plan([range("a", { pauseReason: "profiles-exhausted" })])]);
    const item = notificationsStore.getState().notifications[0]!;
    expect(item).toMatchObject({ id: id("a"), autoClose: false, color: "orange" });
    expect((actionButton(id("a")) as ReactElement<{ size?: string }>).props.size).toBeUndefined();
    actionButton(id("a")).props.onClick();
    await vi.waitFor(() => expect(vpnMocks.navigate).toHaveBeenCalledWith({ to: "/tasks" }));
    expect(vpnMocks.open).not.toHaveBeenCalled(); expect(vpnMocks.initialize).not.toHaveBeenCalled();
  });

  it("preserves per-range dismissal until that owner changes and leaves unrelated notices on cleanup", () => {
    const a = range("a"), b = range("b"); const sync = mount([plan([a, b])]);
    notifications.hide(id("a")); sync.update([plan([a, b])]);
    expect(notificationsStore.getState().notifications.map(item => item.id)).toEqual([id("b")]);
    sync.update([plan([{ ...a, generation: 8 }, b])]);
    expect(notificationsStore.getState().notifications.map(item => item.id)).toEqual([id("b"), id("a")]);
    notifications.show({ id: "unrelated", message: "Unrelated" });
    dispose!(); dispose = undefined;
    expect(sync.unsubscribe).toHaveBeenCalledOnce();
    expect(notificationsStore.getState().notifications.map(item => item.id)).toEqual(["unrelated"]);
  });

  it("uses different identities for the same range label in different plans", () => {
    mount([plan([range("a")]), plan([range("a")], "plan-b")]);
    expect(notificationsStore.getState().notifications.map(item => item.id)).toEqual([id("a"), id("a", "plan-b")]);
  });

  it("does not emit a notice for automatic replacement or unchanged progress", () => {
    const a = range("a", { pauseReason: "challenge-cloudflare", challenge: { kind: "cloudflare", url: "https://source.test/chapter" } });
    const sync = mount([plan([a])]);
    expect(notificationsStore.getState().notifications).toEqual([]);
    sync.update([plan([{ ...a, phase: "connecting", pauseReason: null }])]);
    expect(notificationsStore.getState().notifications).toEqual([]);
    sync.update([plan([range("a")])]);
    const shown = notificationsStore.getState().notifications[0];
    sync.update([plan([range("a")])]);
    expect(notificationsStore.getState().notifications).toEqual([shown]);
  });
});
