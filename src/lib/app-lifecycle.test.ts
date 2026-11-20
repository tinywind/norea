import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ android: false }));
vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: () => runtime.android,
}));

import {
  isAppActive,
  registerBeforeAppSuspend,
  runBeforeAppSuspend,
  subscribeAppLifecycle,
} from "./app-lifecycle";

let browserWindow: EventTarget & {
  __NoreaAndroidTasks?: { isAppActive?: () => boolean };
};
let documentTarget: EventTarget;
let visibilityState: DocumentVisibilityState;

beforeEach(() => {
  runtime.android = false;
  visibilityState = "visible";
  browserWindow = new EventTarget();
  documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", documentTarget);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("app-lifecycle", () => {
  it("tracks document visibility outside Android", () => {
    expect(isAppActive()).toBe(true);
    const events: boolean[] = [];
    const unsubscribe = subscribeAppLifecycle((active) => {
      events.push(active);
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(isAppActive()).toBe(false);

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(isAppActive()).toBe(true);
    expect(events).toEqual([false, true]);

    unsubscribe();
    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(events).toEqual([false, true]);
  });

  it("uses native Android activity state and ignores spoofed WebView visibility", () => {
    runtime.android = true;
    let nativeActive = false;
    browserWindow.__NoreaAndroidTasks = {
      isAppActive: () => nativeActive,
    };
    visibilityState = "visible";
    expect(isAppActive()).toBe(false);

    const events: boolean[] = [];
    const unsubscribe = subscribeAppLifecycle((active) => {
      events.push(active);
    });

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(events).toEqual([]);

    nativeActive = true;
    browserWindow.dispatchEvent(new Event("norea-app-resumed"));
    expect(isAppActive()).toBe(true);

    nativeActive = false;
    browserWindow.dispatchEvent(new Event("norea-app-paused"));
    expect(isAppActive()).toBe(false);
    expect(events).toEqual([true, false]);

    unsubscribe();
    browserWindow.dispatchEvent(new Event("norea-app-resumed"));
    expect(events).toEqual([true, false]);
  });

  it("runs flush hooks before drain hooks and enforces timeout", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const removeFlush = registerBeforeAppSuspend(async () => {
      order.push("flush:start");
      await Promise.resolve();
      order.push("flush:end");
    }, "flush");
    const removeFailing = registerBeforeAppSuspend(() => {
      order.push("flush:error");
      throw new Error("ignored");
    }, "flush");
    const removeDrain = registerBeforeAppSuspend(async () => {
      order.push("drain:start");
      await Promise.resolve();
      order.push("drain:end");
    }, "drain");

    try {
      await runBeforeAppSuspend(500);
      expect(order).toEqual([
        "flush:start",
        "flush:error",
        "flush:end",
        "drain:start",
        "drain:end",
      ]);
    } finally {
      removeFlush();
      removeFailing();
      removeDrain();
    }

    const removeHanging = registerBeforeAppSuspend(
      () => new Promise<void>(() => undefined),
      "drain",
    );
    try {
      let finished = false;
      const run = runBeforeAppSuspend(250).then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(finished).toBe(true);
    } finally {
      removeHanging();
    }
  });
});
