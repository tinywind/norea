import { useEffect } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import * as chapterDownloads from "../lib/tasks/chapter-download";
import * as chapterQueries from "../db/queries/chapter";
import { notifications, notificationsStore } from "@mantine/notifications";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskScheduler } from "../lib/tasks/scheduler";
import type { SourceAccessBlock } from "../lib/tasks/scheduler";
import * as sourceAccessCoordinator from "../lib/tasks/source-access-coordinator";
import { TaskNotifications } from "./TaskNotifications";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueryClient: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

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
    expect(notificationsStore.getState().notifications[0]?.autoClose).toBe(5_000);
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
