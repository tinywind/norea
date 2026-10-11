import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../db/queries/novel", () => ({ findNovelBySource: vi.fn() }));
vi.mock("./sync-novel", () => ({ syncNovelFromSource: vi.fn() }));

import { findNovelBySource } from "../../db/queries/novel";
import { importNovelFromSource } from "./import-novel";
import { syncNovelFromSource } from "./sync-novel";
import type { Plugin } from "./types";

const plugin = { id: "source" } as Plugin;

beforeEach(() => vi.clearAllMocks());

it.each(["/novel/123", "/webtoon/list?titleId=650305&q=%2f#info", "opaque:{\"id\":123}"])("reuses the exact plugin identity %s", async path => {
  vi.mocked(findNovelBySource).mockResolvedValue({ id: 7, path } as never);
  expect(await importNovelFromSource(plugin, {
    name: "Novel", path,
  })).toBe(7);
  expect(findNovelBySource).toHaveBeenCalledWith("source", path);
  expect(syncNovelFromSource).not.toHaveBeenCalled();
});

it.each(["/novel/123", "/webtoon/list?titleId=650305&q=%2f#info", "opaque:{\"id\":123}"])("passes the exact plugin identity %s to a forced refresh", async path => {
  vi.mocked(syncNovelFromSource).mockResolvedValue({ novelId: 8 } as never);
  expect(await importNovelFromSource(plugin, {
    name: "Novel", path,
  }, { forceRefresh: true })).toBe(8);
  expect(syncNovelFromSource).toHaveBeenCalledWith(plugin, {
    name: "Novel", path,
  });
  expect(findNovelBySource).not.toHaveBeenCalled();
});
