import { useEffect } from "react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskScheduler } from "../lib/tasks/scheduler";
import type { SourceAccessBlock } from "../lib/tasks/scheduler";
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

function accessBlock(): SourceAccessBlock {
  return {
    challenge: {
      kind: "captcha",
      url: "https://source.test/chapter/1",
    },
    detectedAt: 1,
    revision: 1,
    scopeKey: "site:source.test",
    sourceIds: ["source-a"],
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
    const scopeKey = "site:source.test";
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
    const secondBlock = { ...block, scopeKey: "site:second.test" };
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
