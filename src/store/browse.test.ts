import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RESOURCE_DOWNLOAD_CONCURRENCY,
  DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS,
  getResourceDownloadConcurrency,
  getSourceRequestTimeoutMs,
  getSourceRequestTimeoutSeconds,
  useBrowseStore,
} from "./browse";

function installMemoryStorage(): void {
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
}

describe("browse store source request timeout", () => {
  beforeEach(() => {
    installMemoryStorage();
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

describe("browse store resource download concurrency", () => {
  beforeEach(() => {
    installMemoryStorage();
    useBrowseStore.setState({
      resourceDownloadConcurrency: DEFAULT_RESOURCE_DOWNLOAD_CONCURRENCY,
    });
  });

  it("defaults to one resource download slot", () => {
    expect(getResourceDownloadConcurrency()).toBe(1);
  });

  it("clamps resource download slots to the supported range", () => {
    useBrowseStore.getState().setResourceDownloadConcurrency(0);
    expect(getResourceDownloadConcurrency()).toBe(1);

    useBrowseStore.getState().setResourceDownloadConcurrency(4);
    expect(getResourceDownloadConcurrency()).toBe(4);

    useBrowseStore.getState().setResourceDownloadConcurrency(99);
    expect(getResourceDownloadConcurrency()).toBe(10);
  });
});
