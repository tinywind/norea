import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkOverrideV1 } from "../../lib/work-metadata/override";
import {
  getNovelOverride,
  listNovelOverrides,
  mergeNovelOverride,
  readNovelOverrideCover,
  updateNovelOverride,
} from "./novel-override";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

const document: WorkOverrideV1 = {
  schemaVersion: 1,
  identity: { pluginId: "source", novelId: "book", novelPath: "/book" },
  fields: { status: { value: "Completed", updatedAt: 1763350000000 } },
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

describe("readNovelOverrideCover", () => {
  it("decodes returned byte arrays into Uint8Array", async () => {
    mockedInvoke.mockResolvedValueOnce({
      fileName: "cover.override.png",
      contentType: "image/png",
      bytes: [1, 2, 3],
    });

    const cover = await readNovelOverrideCover(7, "committed");
    expect(cover).toEqual({
      fileName: "cover.override.png",
      contentType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(mockedInvoke).toHaveBeenCalledWith("db_novel_override_read_cover", {
      novelId: 7,
      mode: "committed",
    });
  });

  it("returns null when no override cover exists", async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    expect(await readNovelOverrideCover(7)).toBeNull();
  });
});

describe("updateNovelOverride", () => {
  it("stores edited fields and cover bytes atomically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1763350000000);
    mockedInvoke.mockResolvedValueOnce({ value: document, effects: {} });

    const bytes = new Uint8Array([137, 80, 78, 71]);
    expect(
      await updateNovelOverride(
        7,
        { name: "Renamed", status: "Completed" },
        { mode: "set", fileName: "cover.override.png", bytes },
      ),
    ).toEqual(document);
    expect(mockedInvoke).toHaveBeenCalledWith("db_novel_override_update", {
      novelId: 7,
      fields: { name: "Renamed", status: "Completed" },
      cover: { mode: "set", fileName: "cover.override.png", bytes: [137, 80, 78, 71] },
      updatedAt: 1763350000000,
    });
  });

  it("sends null fields and clear cover action to revert to source", async () => {
    mockedInvoke.mockResolvedValueOnce({ value: document, effects: {} });

    await updateNovelOverride(7, { status: null }, { mode: "clear" }, 1763350001000);

    expect(mockedInvoke).toHaveBeenCalledWith("db_novel_override_update", {
      novelId: 7,
      fields: { status: null },
      cover: { mode: "clear" },
      updatedAt: 1763350001000,
    });
  });

  it("propagates a rejected edit", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("work override: novel not found"));

    await expect(updateNovelOverride(99, { status: "Completed" })).rejects.toThrow(
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

  it("forwards optional override cover bytes", async () => {
    mockedInvoke.mockResolvedValueOnce({
      value: { document, changed: true },
      effects: {},
    });

    await mergeNovelOverride(7, document, new Uint8Array([9, 8, 7]));
    expect(mockedInvoke).toHaveBeenCalledWith("db_novel_override_merge", {
      novelId: 7,
      document,
      coverBytes: [9, 8, 7],
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
