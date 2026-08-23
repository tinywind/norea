import { beforeEach, describe, expect, it } from "vitest";
import { useSiteBrowserStore } from "./site-browser";

describe("site browser store", () => {
  beforeEach(() => {
    useSiteBrowserStore.setState({
      completion: null,
      context: null,
      currentUrl: null,
      openSequence: 0,
      phase: "closed",
      taskId: null,
      visible: false,
    });
  });

  it("blocks while queued and starts navigation only for the owning task", () => {
    const store = useSiteBrowserStore.getState();

    store.queueAt("https://source.test/novel", "task-1");

    expect(useSiteBrowserStore.getState()).toMatchObject({
      completion: null,
      context: { mode: "browse" },
      currentUrl: "https://source.test/novel",
      openSequence: 0,
      phase: "queued",
      taskId: "task-1",
      visible: true,
    });

    useSiteBrowserStore
      .getState()
      .startLoading("https://source.test/novel", "stale-task");
    expect(useSiteBrowserStore.getState().phase).toBe("queued");

    useSiteBrowserStore
      .getState()
      .startLoading("https://source.test/novel", "task-1");
    expect(useSiteBrowserStore.getState()).toMatchObject({
      openSequence: 1,
      phase: "loading",
    });

    useSiteBrowserStore.getState().markReady("task-1");
    expect(useSiteBrowserStore.getState().phase).toBe("ready");
  });

  it("clears task ownership when hidden", () => {
    useSiteBrowserStore
      .getState()
      .queueAt("https://source.test/novel", "task-1");

    useSiteBrowserStore.getState().hide();

    expect(useSiteBrowserStore.getState()).toMatchObject({
      completion: null,
      context: null,
      phase: "closed",
      taskId: null,
      visible: false,
    });
  });

  it("completes source access requests only for the owning task", () => {
    const context = {
      mode: "source-access" as const,
      challenge: {
        kind: "captcha" as const,
        url: "https://source.test/chapter/1",
      },
      revision: 3,
      scopeKey: "site:source.test",
      sourceName: "Source",
    };
    useSiteBrowserStore
      .getState()
      .queueAt("https://source.test/chapter/1", "task-1", context);

    expect(
      useSiteBrowserStore.getState().complete("stale-task", 3, "verify"),
    ).toBe(false);
    expect(
      useSiteBrowserStore.getState().complete("task-1", 2, "verify"),
    ).toBe(false);
    expect(useSiteBrowserStore.getState()).toMatchObject({
      completion: null,
      context,
      visible: true,
    });

    expect(
      useSiteBrowserStore.getState().complete("task-1", 3, "keep-paused"),
    ).toBe(true);
    expect(useSiteBrowserStore.getState()).toMatchObject({
      completion: {
        outcome: "keep-paused",
        revision: 3,
        scopeKey: "site:source.test",
        taskId: "task-1",
      },
      context: null,
      phase: "closed",
      taskId: null,
      visible: false,
    });
  });

  it("records an explicit verification outcome", () => {
    useSiteBrowserStore.getState().queueAt(
      "https://source.test/chapter/1",
      "task-2",
      {
        mode: "source-access",
        challenge: {
          kind: "cloudflare",
          url: "https://source.test/chapter/1",
        },
        revision: 4,
        scopeKey: "site:source.test",
        sourceName: "Source",
      },
    );
    useSiteBrowserStore
      .getState()
      .startLoading("https://source.test/chapter/1", "task-2");
    useSiteBrowserStore.getState().markReady("task-2");

    useSiteBrowserStore.getState().complete("task-2", 4, "verify");

    expect(useSiteBrowserStore.getState().completion).toEqual({
      outcome: "verify",
      revision: 4,
      scopeKey: "site:source.test",
      taskId: "task-2",
    });
  });
});
