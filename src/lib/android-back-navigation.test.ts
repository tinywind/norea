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
    const firstBack = vi.fn(() => true);
    const secondBack = vi.fn(() => true);
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

  it("falls through when a newer handler performs no action", () => {
    vi.stubGlobal("window", {});
    const pageBack = vi.fn(() => true);
    const staleBack = vi.fn(() => false);
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(
      registerPageBackNavigationHandler({ back: pageBack }),
      registerPageBackNavigationHandler({ back: staleBack }),
    );

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(staleBack).toHaveBeenCalledTimes(1);
    expect(pageBack).toHaveBeenCalledTimes(1);
  });

  it("falls through after a transient handler finishes its work", () => {
    vi.stubGlobal("window", {});
    const pageBack = vi.fn(() => true);
    const transientBack = vi.fn(() => false).mockReturnValueOnce(true);
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(
      registerPageBackNavigationHandler({ back: pageBack }),
      registerPageBackNavigationHandler({ back: transientBack }),
    );

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(pageBack).not.toHaveBeenCalled();

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(pageBack).toHaveBeenCalledTimes(1);
  });

  it("leaves back navigation unhandled when no handler performs an action", () => {
    vi.stubGlobal("window", {});
    const noActionBack = vi.fn(() => false);
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(
      registerPageBackNavigationHandler({ back: noActionBack }),
    );

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(false);
    expect(noActionBack).toHaveBeenCalledTimes(1);
  });
});
