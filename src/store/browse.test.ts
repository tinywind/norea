import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storageHarness = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  return { descriptor, values, windowDescriptor };
});

import {
  DEFAULT_SOURCE_DISPLAY_MODE,
  DEFAULT_SOURCE_NOVELS_PER_ROW,
  DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS,
  getSourceRequestTimeoutMs,
  getSourceRequestTimeoutSeconds,
  useBrowseStore,
} from "./browse";

function resetMemoryStorage(): void {
  storageHarness.values.clear();
}

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

describe("browse store source request timeout", () => {
  beforeEach(() => {
    resetMemoryStorage();
    useBrowseStore.setState({
      sourceRequestTimeoutSeconds: DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS,
    });
  });

  it("exposes the configured timeout in seconds and milliseconds", () => {
    useBrowseStore.setState({ sourceRequestTimeoutSeconds: 45 });

    expect(getSourceRequestTimeoutSeconds()).toBe(45);
    expect(getSourceRequestTimeoutMs()).toBe(45_000);
  });

  it("clamps request timeout settings to the supported range", () => {
    useBrowseStore.setState({ sourceRequestTimeoutSeconds: 1 });
    expect(getSourceRequestTimeoutSeconds()).toBe(5);

    useBrowseStore.setState({ sourceRequestTimeoutSeconds: 500 });
    expect(getSourceRequestTimeoutSeconds()).toBe(120);
  });
});

describe("browse store global search sort", () => {
  it("keeps a known sort choice and falls back to pinned order otherwise", () => {
    useBrowseStore.getState().setGlobalSearchSort("name");
    expect(useBrowseStore.getState().globalSearchSort).toBe("name");

    useBrowseStore.getState().setGlobalSearchSort("count" as never);
    expect(useBrowseStore.getState().globalSearchSort).toBe("pinned");
  });
});

describe("browse store automatic extension updates", () => {
  it("is off until the user turns it on", () => {
    expect(useBrowseStore.getInitialState().autoUpdateExtensions).toBe(false);
    useBrowseStore.getState().setAutoUpdateExtensions(true);
    expect(useBrowseStore.getState().autoUpdateExtensions).toBe(true);
    useBrowseStore.getState().setAutoUpdateExtensions(false);
  });
});

describe("browse store source display settings", () => {
  beforeEach(() => {
    resetMemoryStorage();
    useBrowseStore.setState({
      sourceDisplayMode: DEFAULT_SOURCE_DISPLAY_MODE,
      sourceNovelsPerRow: DEFAULT_SOURCE_NOVELS_PER_ROW,
    });
  });

  it("persists and rehydrates display mode and novels per row across sessions", async () => {
    useBrowseStore.getState().setSourceDisplayMode("list");
    useBrowseStore.getState().setSourceNovelsPerRow(5);

    expect(useBrowseStore.getState().sourceDisplayMode).toBe("list");
    expect(useBrowseStore.getState().sourceNovelsPerRow).toBe(5);

    const saved = localStorage.getItem("browse-plugin-settings");
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).state).toMatchObject({
      sourceDisplayMode: "list",
      sourceNovelsPerRow: 5,
    });

    useBrowseStore.setState({
      sourceDisplayMode: DEFAULT_SOURCE_DISPLAY_MODE,
      sourceNovelsPerRow: DEFAULT_SOURCE_NOVELS_PER_ROW,
    });
    localStorage.setItem("browse-plugin-settings", saved!);
    await useBrowseStore.persist.rehydrate();

    expect(useBrowseStore.getState().sourceDisplayMode).toBe("list");
    expect(useBrowseStore.getState().sourceNovelsPerRow).toBe(5);
  });

  it("normalizes out-of-range column counts and unknown display modes", () => {
    useBrowseStore.getState().setSourceDisplayMode("grid-99" as never);
    useBrowseStore.getState().setSourceNovelsPerRow(0);
    expect(useBrowseStore.getState().sourceDisplayMode).toBe(
      DEFAULT_SOURCE_DISPLAY_MODE,
    );
    expect(useBrowseStore.getState().sourceNovelsPerRow).toBe(1);

    useBrowseStore.getState().setSourceNovelsPerRow(12);
    expect(useBrowseStore.getState().sourceNovelsPerRow).toBe(5);
  });
});
