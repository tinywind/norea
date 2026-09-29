import { beforeEach, describe, expect, it } from "vitest";
import { useSiteBrowserStore } from "./site-browser";

const URL = "https://source.test/page";
function open() {
  const store = useSiteBrowserStore.getState();
  store.queueAt("source-a", URL, "task-1");
  store.startLoading("source-a", URL, "task-1");
  return useSiteBrowserStore.getState();
}
function fail() {
  const state = useSiteBrowserStore.getState();
  state.markNavigationError("task-1", state.openSequence, "net::ERR_CONNECTION_CLOSED");
}

beforeEach(() => useSiteBrowserStore.getState().hide());

describe("site browser navigation error recovery", () => {
  it("retains the browser, source, address, and task when navigation fails", () => {
    open();
    fail();
    expect(useSiteBrowserStore.getState()).toMatchObject({
      visible: true, phase: "error", sourceId: "source-a", taskId: "task-1",
      currentUrl: URL, navigationError: "net::ERR_CONNECTION_CLOSED", completion: null,
    });
  });

  it.each([URL, "https://other.test/"])("retries or changes the failed address to %s", (url) => {
    const previous = open().openSequence;
    fail();
    useSiteBrowserStore.getState().navigateTo("task-1", url);
    expect(useSiteBrowserStore.getState()).toMatchObject({
      visible: true, phase: "loading", navigationError: null, currentUrl: url,
      taskId: "task-1", sourceId: "source-a", openSequence: previous + 1,
    });
  });

  it("ignores errors from an earlier navigation or another task", () => {
    const previous = open().openSequence;
    fail();
    const store = useSiteBrowserStore.getState();
    store.navigateTo("task-1", URL);
    store.markNavigationError("task-1", previous, "stale");
    store.markNavigationError("other-task", previous + 1, "wrong owner");
    expect(useSiteBrowserStore.getState()).toMatchObject({ phase: "loading", navigationError: null });
  });

  it("never reopens a closed browser for a late failure", () => {
    const previous = open().openSequence;
    const store = useSiteBrowserStore.getState();
    store.hide();
    store.markNavigationError("task-1", previous, "late");
    expect(useSiteBrowserStore.getState()).toMatchObject({ visible: false, phase: "closed", navigationError: null });
  });

  it("does not allow a failed challenge page to confirm source access", () => {
    const store = useSiteBrowserStore.getState();
    const context = {
      mode: "source-access" as const,
      challenge: { kind: "cloudflare" as const, url: URL },
      revision: 2, scopeKey: "site:source.test", sourceName: "Source A",
    };
    store.queueAt("source-a", URL, "task-1", context);
    store.startLoading("source-a", URL, "task-1");
    fail();
    expect(store.complete("task-1", 2, "verify")).toBe(false);
    expect(useSiteBrowserStore.getState().context).toEqual(context);
    expect(store.complete("task-1", 2, "keep-paused")).toBe(true);
    expect(useSiteBrowserStore.getState()).toMatchObject({ visible: false, navigationError: null });
  });

  it("redacts URL details and clears errors on another open", () => {
    const state = open();
    state.markNavigationError("task-1", state.openSequence, "Failed at https://source.test/private?q=example#fragment");
    expect(useSiteBrowserStore.getState().navigationError).toBe("Failed at https://source.test");
    state.queueAt("source-b", "https://other.test/", "task-2");
    expect(useSiteBrowserStore.getState()).toMatchObject({ phase: "queued", navigationError: null });
  });
});
