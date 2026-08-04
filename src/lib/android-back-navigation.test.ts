import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPageBackNavigationHandler,
  startAndroidBackNavigationBridge,
} from "./android-back-navigation";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

describe("Android back navigation", () => {
  it("leaves back navigation unhandled when the page has no explicit handler", () => {
    vi.stubGlobal("window", {});
    cleanups.push(startAndroidBackNavigationBridge());

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(false);
  });

  it("uses the most recently registered page back handler", () => {
    vi.stubGlobal("window", {});
    const firstBack = vi.fn();
    const secondBack = vi.fn();
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(
      registerPageBackNavigationHandler({ back: firstBack }),
      registerPageBackNavigationHandler({ back: secondBack }),
    );

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(secondBack).toHaveBeenCalledTimes(1);
    expect(firstBack).not.toHaveBeenCalled();

    cleanups.pop()?.();

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(firstBack).toHaveBeenCalledTimes(1);
  });
});
