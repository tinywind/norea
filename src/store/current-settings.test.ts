import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storageHarness = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  return { descriptor, windowDescriptor, values };
});

import { DEFAULT_APPEARANCE, useAppearanceStore } from "./appearance";
import {
  DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_SOURCE_WORK_CONCURRENCY,
  useBrowseStore,
} from "./browse";
import { READER_CUSTOM_CSS_PRESETS, useReaderStore } from "./reader";
import { DEFAULT_USER_AGENT, useUserAgentStore } from "./user-agent";

beforeEach(() => {
  storageHarness.values.clear();
  useAppearanceStore.getState().resetAppearance();
  useReaderStore.getState().resetReaderSettings();
  useUserAgentStore.setState({ userAgent: DEFAULT_USER_AGENT });
});

afterAll(() => {
  if (storageHarness.descriptor) {
    Object.defineProperty(globalThis, "localStorage", storageHarness.descriptor);
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
  if (storageHarness.windowDescriptor) {
    Object.defineProperty(globalThis, "window", storageHarness.windowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
});

describe("current persisted settings", () => {
  it("ignores a user agent stored under an obsolete version", async () => {
    storageHarness.values.set("http-user-agent", JSON.stringify({
      version: 0,
      state: { userAgent: "obsolete custom agent" },
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await useUserAgentStore.persist.rehydrate();
      expect(useUserAgentStore.getState().userAgent).toBe(DEFAULT_USER_AGENT);
    } finally {
      error.mockRestore();
    }
  });

  it("restores a user agent stored under the current version", async () => {
    storageHarness.values.set("http-user-agent", JSON.stringify({
      version: 1,
      state: { userAgent: "current custom agent" },
    }));
    await useUserAgentStore.persist.rehydrate();
    expect(useUserAgentStore.getState().userAgent).toBe("current custom agent");
  });

  it("ignores obsolete global search setting names", async () => {
    storageHarness.values.set("browse-plugin-settings", JSON.stringify({
      version: 0,
      state: { globalSearchConcurrency: 8, globalSearchTimeoutSeconds: 95 },
    }));
    await useBrowseStore.persist.rehydrate();
    expect(useBrowseStore.getState().sourceWorkConcurrency).toBe(
      DEFAULT_SOURCE_WORK_CONCURRENCY,
    );
    expect(useBrowseStore.getState().sourceRequestTimeoutSeconds).toBe(
      DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS,
    );
  });

  it("ignores the obsolete combined UI scale setting", async () => {
    storageHarness.values.set("app-appearance-settings", JSON.stringify({
      version: 0,
      state: { uiScalePercent: 135 },
    }));
    await useAppearanceStore.persist.rehydrate();
    expect(useAppearanceStore.getState().fontScalePercent).toBe(
      DEFAULT_APPEARANCE.fontScalePercent,
    );
  });

  it("keeps saved CSS unchanged even when it matches an old preset", async () => {
    const customCss = READER_CUSTOM_CSS_PRESETS.find(
      (preset) => preset.id === "page-fit-media",
    )!.css.replace(
      "var(--norea-reader-page-media-max-height, 100dvh)",
      "calc(100dvh - 8rem)",
    );
    storageHarness.values.set("reader-settings", JSON.stringify({
      version: 0,
      state: { appearance: { customCss } },
    }));
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().appearance.customCss).toBe(customCss);
  });
});
