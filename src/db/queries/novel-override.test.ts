import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkOverrideV1 } from "../../lib/work-metadata/override";
import {
  getNovelOverride,
  listNovelOverrides,
  mergeNovelOverride,
  setNovelCompletedOverride,
} from "./novel-override";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

const document: WorkOverrideV1 = {
  schemaVersion: 1,
  identity: { pluginId: "source", novelId: "book", novelPath: "/book" },
  fields: { completed: { value: true, updatedAt: 1763350000000 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("getNovelOverride", () => {
  it("reads the stored override of one novel", async () => {
    mockedInvoke.mockResolvedValueOnce(document);

    expect(await getNovelOverride(7)).toEqual(document);
    expect(mockedInvoke).toHaveBeenCalledWith("db_novel_override_get", {
      novelId: 7,
      mode: "queued",
    });
  });

  it("returns null for a novel without an override", async () => {
    mockedInvoke.mockResolvedValueOnce(null);

    expect(await getNovelOverride(8)).toBeNull();
  });
});

describe("listNovelOverrides", () => {
  it("lists every stored override with its novel", async () => {
    const stored = [{ novelId: 7, isLocal: false, document }];
    mockedInvoke.mockResolvedValueOnce(stored);

    expect(await listNovelOverrides()).toEqual(stored);
    expect(mockedInvoke).toHaveBeenCalledWith("db_novel_override_list", {
      mode: "queued",
    });
  });
});

describe("setNovelCompletedOverride", () => {
  it("stores the flag with the current time and returns the document", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1763350000000);
    mockedInvoke.mockResolvedValueOnce({ value: document, effects: {} });

    expect(await setNovelCompletedOverride(7, true)).toEqual(document);
    expect(mockedInvoke).toHaveBeenCalledWith("db_novel_override_set_field", {
      novelId: 7,
      field: "completed",
      value: true,
      updatedAt: 1763350000000,
    });
  });

  it("sends null to follow the source status again", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: document, effects: {} });

    await setNovelCompletedOverride(7, null);

    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_novel_override_set_field",
      expect.objectContaining({ novelId: 7, field: "completed", value: null }),
    );
  });

  it("propagates a rejected edit", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("work override: novel not found"));

    await expect(setNovelCompletedOverride(99, true)).rejects.toThrow(
      "work override: novel not found",
    );
  });
});

describe("mergeNovelOverride", () => {
  it("merges a document and reports whether the stored override changed", async () => {
    mockedInvoke.mockResolvedValueOnce({
      value: { document, changed: true },
      effects: {},
    });

    expect(await mergeNovelOverride(7, document)).toEqual({ document, changed: true });
    expect(mockedInvoke).toHaveBeenCalledWith("db_novel_override_merge", {
      novelId: 7,
      document,
    });
  });

  it("returns a null document when nothing is stored", async () => {
    mockedInvoke.mockResolvedValueOnce({
      value: { document: null, changed: false },
      effects: {},
    });

    expect(await mergeNovelOverride(7, { ...document, fields: {} })).toEqual({
      document: null,
      changed: false,
    });
  });
});
