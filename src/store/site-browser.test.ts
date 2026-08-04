import { beforeEach, describe, expect, it } from "vitest";
import { useSiteBrowserStore } from "./site-browser";

describe("site browser store", () => {
  beforeEach(() => {
    useSiteBrowserStore.setState({
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
      phase: "closed",
      taskId: null,
      visible: false,
    });
  });
});
