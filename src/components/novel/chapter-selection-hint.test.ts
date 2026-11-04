import { afterEach, expect, it, vi } from "vitest";
import { CHAPTER_SELECTION_HINT_KEY, takeChapterSelectionHint } from "./chapter-selection-hint";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the hint once per device", () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  expect(takeChapterSelectionHint()).toBe(true);
  expect(stored.has(CHAPTER_SELECTION_HINT_KEY)).toBe(true);
  expect(takeChapterSelectionHint()).toBe(false);
});

it("stays hidden when storage is unavailable", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
  });
  expect(takeChapterSelectionHint()).toBe(false);
});
