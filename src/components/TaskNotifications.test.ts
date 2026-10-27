import { useEffect } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import * as chapterDownloads from "../lib/tasks/chapter-download";
import { notifications, notificationsStore } from "@mantine/notifications";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskScheduler } from "../lib/tasks/scheduler";
import type { SourceAccessBlock } from "../lib/tasks/scheduler";
import * as sourceAccessCoordinator from "../lib/tasks/source-access-coordinator";
import {
  completeAutoOpenSourceAccessAttempt,
  nextAutoOpenSourceAccessBlock,
  TaskNotifications,
} from "./TaskNotifications";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueryClient: vi.fn(),
}));
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
      await vi.waitFor(() => expect(client.getQueryData([...metadataKey, "chapters"])).toEqual([{ id: 11, isDownloaded: true }]));
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

describe("nextAutoOpenSourceAccessBlock", () => {
  it("keeps a new block pending until its origin task is queued", () => {
    const block = accessBlock();
    const knownScopes = new Set<string>();
    const pendingScopes = new Set<string>();
    let canBegin = false;

    expect(
      nextAutoOpenSourceAccessBlock(
        [block],
        knownScopes,
        pendingScopes,
        () => canBegin,
      ),
    ).toBeUndefined();
    expect(pendingScopes).toEqual(new Set([block.scopeKey]));

    canBegin = true;
    expect(
      nextAutoOpenSourceAccessBlock(
        [block],
        knownScopes,
        pendingScopes,
        () => canBegin,
      ),
    ).toBe(block);
  });

  it("keeps a block pending after a transient browser open failure", () => {
    const scopeKey = "plugin:source-a:site:source.test";
    const pendingScopes = new Set([scopeKey]);
    const inFlightScopes = new Set([scopeKey]);

    completeAutoOpenSourceAccessAttempt(
      scopeKey,
      false,
      pendingScopes,
      inFlightScopes,
    );

    expect(pendingScopes).toEqual(new Set([scopeKey]));
    expect(inFlightScopes).toEqual(new Set());

    inFlightScopes.add(scopeKey);
    completeAutoOpenSourceAccessAttempt(
      scopeKey,
      true,
      pendingScopes,
      inFlightScopes,
    );

    expect(pendingScopes).toEqual(new Set());
    expect(inFlightScopes).toEqual(new Set());
  });
});

describe("source access notifications", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    notifications.clean();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function mountNotifications(initialBlocks: SourceAccessBlock[]) {
    let blocks = initialBlocks;
    const snapshot = taskScheduler.getSnapshot();
    let sync = () => {};
    vi.spyOn(taskScheduler, "getSnapshot").mockImplementation(() => ({
      ...snapshot,
      sourceAccessBlocks: blocks,
    }));
    vi.spyOn(taskScheduler, "subscribe").mockImplementation((listener) => {
      sync = listener;
      return () => {};
    });
    vi.spyOn(taskScheduler, "canBeginSourceAccessVerification").mockReturnValue(
      false,
    );
    TaskNotifications();
    dispose = vi.mocked(useEffect).mock.calls[1]![0]() as () => void;
    return (nextBlocks = blocks) => {
      blocks = nextBlocks;
      sync();
    };
  }

  it("opens a restored challenge when a new source request becomes eligible", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    const open = vi.spyOn(sourceAccessCoordinator, "openSourceAccessBrowser")
      .mockResolvedValue(true);
    const sync = mountNotifications([accessBlock()]);
    expect(open).not.toHaveBeenCalled();
    vi.mocked(taskScheduler.canBeginSourceAccessVerification).mockReturnValue(true);

    sync();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    sync();
    expect(open).toHaveBeenCalledOnce();
  });

  it("allows dismissal without reopening on task updates or unblocking access", () => {
    const block = accessBlock();
    const sync = mountNotifications([block]);
    const notification = notificationsStore.getState().notifications[0]!;

    expect(notification.withCloseButton).toBe(true);
    expect(notification.closeButtonProps?.["aria-label"]).toBe(
      "sourceAccess.dismissNotification",
    );
    notifications.hide(notification.id!);
    sync([{ ...block }]);

    expect(notificationsStore.getState().notifications).toEqual([]);
    expect(taskScheduler.getSnapshot().sourceAccessBlocks).toEqual([block]);
  });

  it("notifies again for a new challenge revision after dismissal", () => {
    const block = accessBlock();
    const sync = mountNotifications([block]);
    notifications.hide(notificationsStore.getState().notifications[0]!.id!);

    sync([{ ...block, revision: block.revision + 1 }]);

    expect(notificationsStore.getState().notifications).toHaveLength(1);
  });

  it("does not let a dismissed source hide other blocked sources", () => {
    const block = accessBlock();
    const secondBlock = { ...block, scopeKey: "plugin:source-a:site:second.test" };
    const sync = mountNotifications([block, secondBlock]);
    notifications.hide(notificationsStore.getState().notifications[0]!.id!);
    sync();

    expect(notificationsStore.getState().notifications).toHaveLength(1);
    notifications.hide(notificationsStore.getState().notifications[0]!.id!);
    sync();
    expect(notificationsStore.getState().notifications).toEqual([]);
  });

  it("forgets dismissal after access is restored", () => {
    const block = accessBlock();
    const sync = mountNotifications([block]);
    notifications.hide(notificationsStore.getState().notifications[0]!.id!);
    sync([]);
    sync([block]);

    expect(notificationsStore.getState().notifications).toHaveLength(1);
  });
});
