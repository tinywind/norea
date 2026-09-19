import { describe, expect, it } from "vitest";
import {
  pageInstanceKey,
  readHistoryEntryKey,
  reducePageStack,
  type PageStackEntry,
  type PageStackLocation,
  type PageStackOptions,
} from "./page-stack";

const options: PageStackOptions = {
  maxHiddenEntries: 3,
  singleInstancePathnames: new Set(["/reader"]),
  stackedPathnames: new Set(["/novel", "/reader", "/source"]),
};

function at(
  historyIndex: number,
  pathname: string,
  search: Record<string, unknown> = {},
  historyKey = `key-${historyIndex}`,
): PageStackLocation {
  return { historyIndex, historyKey, pathname, search };
}

describe("reducePageStack", () => {
  it("ignores locations that are not stacked pages", () => {
    expect(reducePageStack([], at(0, "/"), options)).toEqual([]);
  });

  it("keeps earlier pages mounted while a new page is pushed", () => {
    const first = reducePageStack([], at(1, "/source", { pluginId: "p" }), options);
    const second = reducePageStack(first, at(2, "/novel", { id: 7 }), options);

    expect(second.map((entry) => entry.pathname)).toEqual(["/source", "/novel"]);
    expect(second[0]).toBe(first[0]);
  });

  it("returns the same stack when the location is unchanged", () => {
    const location = at(1, "/novel", { id: 7 });
    const stack = reducePageStack([], location, options);

    expect(reducePageStack(stack, location, options)).toBe(stack);
  });

  it("drops pages above the current entry when navigating back", () => {
    const novelSearch = { id: 7 };
    let stack = reducePageStack([], at(1, "/source"), options);
    stack = reducePageStack(stack, at(2, "/novel", novelSearch), options);
    stack = reducePageStack(stack, at(3, "/reader", { chapterId: 9 }), options);

    const back = reducePageStack(stack, at(2, "/novel", novelSearch), options);

    expect(back.map((entry) => entry.pathname)).toEqual(["/source", "/novel"]);
    expect(back[1]).toBe(stack[1]);
  });

  it("keeps hidden pages under a tab page and shows them again on back", () => {
    const readerSearch = { chapterId: 9 };
    let stack = reducePageStack([], at(1, "/novel", { id: 7 }), options);
    stack = reducePageStack(stack, at(2, "/reader", readerSearch), options);

    const onTab = reducePageStack(stack, at(3, "/settings"), options);
    expect(onTab).toBe(stack);

    const back = reducePageStack(onTab, at(2, "/reader", readerSearch), options);
    expect(back).toBe(stack);
  });

  it("replaces a page instance when the same history index gets a new key", () => {
    const stack = reducePageStack([], at(1, "/novel", { id: 7 }, "a"), options);
    const replaced = reducePageStack(stack, at(1, "/novel", { id: 8 }, "b"), options);

    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.instanceKey).not.toBe(stack[0]?.instanceKey);
    expect(replaced[0]?.search).toEqual({ id: 8 });
  });

  it("reuses the single reader instance across chapter replacements", () => {
    const stack = reducePageStack([], at(2, "/reader", { chapterId: 9 }, "a"), options);
    const nextChapter = reducePageStack(
      stack,
      at(2, "/reader", { chapterId: 10 }, "b"),
      options,
    );

    expect(nextChapter).toHaveLength(1);
    expect(nextChapter[0]?.instanceKey).toBe(stack[0]?.instanceKey);
    expect(nextChapter[0]?.search).toEqual({ chapterId: 10 });
  });

  it("drops a page when its history entry is replaced by another page", () => {
    const stack = reducePageStack([], at(2, "/reader", { chapterId: 9 }, "a"), options);
    const replaced = reducePageStack(stack, at(2, "/novel", { id: 7 }, "b"), options);

    expect(replaced.map((entry) => entry.pathname)).toEqual(["/novel"]);
  });

  it("discards stale pages when a new page is pushed after going back", () => {
    const novelSearch = { id: 7 };
    let stack = reducePageStack([], at(1, "/novel", novelSearch), options);
    stack = reducePageStack(stack, at(2, "/reader", { chapterId: 9 }), options);
    stack = reducePageStack(stack, at(1, "/novel", novelSearch), options);

    const pushed = reducePageStack(
      stack,
      at(2, "/source", { pluginId: "p" }, "key-2b"),
      options,
    );

    expect(pushed.map((entry) => entry.pathname)).toEqual(["/novel", "/source"]);
    expect(pushed[0]).toBe(stack[0]);
  });

  it("limits how many hidden pages stay mounted", () => {
    let stack: readonly PageStackEntry[] = [];
    for (let index = 1; index <= 5; index += 1) {
      stack = reducePageStack(stack, at(index, "/novel", { id: index }), options);
    }

    expect(stack.map((entry) => entry.historyIndex)).toEqual([2, 3, 4, 5]);
  });
});

describe("pageInstanceKey", () => {
  it("scopes ordinary pages to their history entry", () => {
    expect(
      pageInstanceKey({ historyKey: "abc", pathname: "/novel" }, options),
    ).toBe("/novel#abc");
  });

  it("shares one key for single-instance pages", () => {
    expect(
      pageInstanceKey({ historyKey: "abc", pathname: "/reader" }, options),
    ).toBe("/reader");
  });
});

describe("readHistoryEntryKey", () => {
  it("reads the TanStack history key", () => {
    expect(readHistoryEntryKey({ __TSR_key: "tsr", key: "legacy" })).toBe("tsr");
    expect(readHistoryEntryKey({ key: "legacy" })).toBe("legacy");
  });

  it("returns null without a usable key", () => {
    expect(readHistoryEntryKey(null)).toBeNull();
    expect(readHistoryEntryKey({ __TSR_index: 3 })).toBeNull();
    expect(readHistoryEntryKey({ key: "" })).toBeNull();
  });
});
