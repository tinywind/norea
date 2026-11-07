import { describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_FAILURE_STOP_STORAGE_KEY,
  initializeDownloadFailureStopPersistence,
  loadPersistedDownloadFailureStops,
  type DownloadFailureStops,
} from "./download-failure-stop";

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: (key: string) => key === DOWNLOAD_FAILURE_STOP_STORAGE_KEY ? value : null,
    setItem: vi.fn((key: string, next: string) => {
      if (key === DOWNLOAD_FAILURE_STOP_STORAGE_KEY) value = next;
    }),
    value: () => value,
  };
}

function memoryScheduler() {
  let stops: DownloadFailureStops = { sourceErrors: {} };
  const listeners = new Set<() => void>();
  return {
    getDownloadFailureStops: () => stops,
    hydrateDownloadFailureStops: (saved: DownloadFailureStops) => { stops = saved; },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update: (next: DownloadFailureStops) => {
      stops = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("download failure stop persistence", () => {
  it("restores source and global stops before subscribing to later changes", () => {
    const storage = memoryStorage(JSON.stringify({ version: 1, sourceErrors: { "source-a": "HTTP 503" }, globalError: "Disk is full" }));
    const scheduler = memoryScheduler();
    const subscribe = scheduler.subscribe;
    scheduler.subscribe = listener => {
      expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: { "source-a": "HTTP 503" }, globalError: "Disk is full" });
      return subscribe(listener);
    };
    initializeDownloadFailureStopPersistence(scheduler, storage);
    expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: { "source-a": "HTTP 503" }, globalError: "Disk is full" });
  });

  it("persists new failures and explicit clearing across restarts", () => {
    const storage = memoryStorage();
    const scheduler = memoryScheduler();
    initializeDownloadFailureStopPersistence(scheduler, storage);
    scheduler.update({ sourceErrors: { "source-a": "Page parsing failed" } });
    const restarted = memoryScheduler();
    initializeDownloadFailureStopPersistence(restarted, storage);
    expect(restarted.getDownloadFailureStops()).toEqual({ sourceErrors: { "source-a": "Page parsing failed" } });
    restarted.update({ sourceErrors: {} });
    expect(loadPersistedDownloadFailureStops(storage)).toEqual({ sourceErrors: {} });
  });

  it("redacts URL secrets and bounds saved messages without changing runtime errors", () => {
    const storage = memoryStorage();
    const scheduler = memoryScheduler();
    initializeDownloadFailureStopPersistence(scheduler, storage);
    const error = `Failed https://user:password@source.test/private/chapter?token=secret#proof ${"x".repeat(500)}`;
    scheduler.update({ sourceErrors: { "source-a": error }, globalError: error });
    const saved = JSON.parse(storage.value()!);
    expect(saved.sourceErrors["source-a"]).toContain("https://source.test");
    expect(saved.sourceErrors["source-a"].length).toBeLessThanOrEqual(300);
    expect(saved.globalError.length).toBeLessThanOrEqual(300);
    expect(storage.value()).not.toMatch(/user|password|private|token|secret|proof/);
    expect(scheduler.getDownloadFailureStops().globalError).toBe(error);
  });

  it("drops invalid source IDs and messages while preserving valid stops", () => {
    const sourceErrors = JSON.parse('{"source-a":"HTTP 500","__proto__":"unsafe","constructor":"unsafe","prototype":"unsafe","https://source.test/":"unsafe","blank":" ","object":{"message":"unsafe"}}');
    sourceErrors["x".repeat(129)] = "unsafe";
    sourceErrors.long = "x".repeat(301);
    const storage = memoryStorage(JSON.stringify({ version: 1, sourceErrors, globalError: 42 }));
    expect(loadPersistedDownloadFailureStops(storage)).toEqual({ sourceErrors: { "source-a": "HTTP 500" } });
    expect(Object.prototype).not.toHaveProperty("unsafe");
  });

  it.each([null, "{", "null", "[]", '{"version":2,"sourceErrors":{"source-a":"HTTP 500"}}', '{"version":1,"sourceErrors":[]}'])
    ("ignores malformed or unsupported saved state: %s", value => {
      expect(loadPersistedDownloadFailureStops(memoryStorage(value))).toEqual({ sourceErrors: {} });
    });

  it("does not rewrite unchanged stops and unsubscribes when disposed", () => {
    const storage = memoryStorage();
    const scheduler = memoryScheduler();
    const stop = initializeDownloadFailureStopPersistence(scheduler, storage);
    const writes = storage.setItem.mock.calls.length;
    scheduler.update({ sourceErrors: {} });
    expect(storage.setItem).toHaveBeenCalledTimes(writes);
    stop();
    scheduler.update({ sourceErrors: { "source-a": "HTTP 500" } });
    expect(loadPersistedDownloadFailureStops(storage)).toEqual({ sourceErrors: {} });
  });

  it("keeps the in-memory stop usable when storage reads or writes fail", () => {
    const storage = { getItem: () => { throw new Error("Unavailable"); }, setItem: () => { throw new Error("Full"); } };
    const scheduler = memoryScheduler();
    expect(() => initializeDownloadFailureStopPersistence(scheduler, storage)).not.toThrow();
    scheduler.update({ sourceErrors: { "source-a": "HTTP 500" } });
    expect(scheduler.getDownloadFailureStops().sourceErrors["source-a"]).toBe("HTTP 500");
    expect(() => initializeDownloadFailureStopPersistence(memoryScheduler(), null)).not.toThrow();
  });
});
