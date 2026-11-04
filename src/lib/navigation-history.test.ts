import { afterEach, beforeEach, expect, it, vi } from "vitest";

const go = vi.fn();

beforeEach(() => {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    history: { go },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});

afterEach(() => {
  go.mockClear();
  vi.unstubAllGlobals();
});

it("goes back past ignored pathnames to the page Settings was opened from", async () => {
  const history = await import("./navigation-history");
  history.recordAppNavigationEntry({ historyIndex: 0, href: "/more", pathname: "/more" });
  history.recordAppNavigationEntry({ historyIndex: 1, href: "/settings", pathname: "/settings" });
  history.recordAppNavigationEntry({ historyIndex: 2, href: "/settings?section=about", pathname: "/settings" });

  expect(history.goBackInAppHistory("/settings?section=about")).toBe(true);
  expect(go).toHaveBeenLastCalledWith(-1);

  history.recordAppNavigationEntry({ historyIndex: 2, href: "/settings?section=about", pathname: "/settings" });
  expect(history.goBackInAppHistory("/settings?section=about", ["/settings"])).toBe(true);
  expect(go).toHaveBeenLastCalledWith(-2);
});

it("reports no previous entry after a cold start", async () => {
  const history = await import("./navigation-history");
  history.recordAppNavigationEntry({ historyIndex: 0, href: "/settings?section=about", pathname: "/settings" });

  expect(history.goBackInAppHistory("/settings?section=about")).toBe(false);
  expect(go).not.toHaveBeenCalled();
});

it("recognizes only the history state More attaches to its links", async () => {
  const { isOpenedFromMore, OPENED_FROM_MORE_STATE } = await import("./navigation-history");

  expect(isOpenedFromMore({ ...OPENED_FROM_MORE_STATE, __TSR_index: 3 })).toBe(true);
  expect(isOpenedFromMore({ __TSR_index: 3 })).toBe(false);
  expect(isOpenedFromMore(undefined)).toBe(false);
});
