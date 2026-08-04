import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS,
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
