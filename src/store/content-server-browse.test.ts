import { afterEach, beforeEach, expect, it, vi } from "vitest";

const STORAGE_KEY = "content-server-browse-filters";
let values: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

afterEach(() => vi.unstubAllGlobals());

it("restores server-specific filters after a document reload creates a new store", async () => {
  const first = (await import("./content-server-browse")).useContentServerBrowseStore;
  first.getState().setFilters("http://server", {
    draft: "QA Server ", query: "QA Server", source: "qa-source",
  });
  first.getState().setFilters("https://other-server", { draft: "Other", query: "Other" });
  expect(JSON.parse(values.get(STORAGE_KEY)!)).toMatchObject({ version: 1 });

  vi.resetModules();
  const restored = (await import("./content-server-browse")).useContentServerBrowseStore;
  expect(restored).not.toBe(first);
  expect(restored.getState().filtersByServer).toEqual({
    "http://server": { draft: "QA Server ", query: "QA Server", source: "qa-source" },
    "https://other-server": { draft: "Other", query: "Other", source: "" },
  });
  restored.getState().setFilters("http://server", { source: "new-source" });
  expect(restored.getState().filtersByServer["https://other-server"]!.query).toBe("Other");
});

it("validates rehydrated fields and never replaces store actions from storage", async () => {
  const store = (await import("./content-server-browse")).useContentServerBrowseStore;
  values.set(STORAGE_KEY, JSON.stringify({
    version: 1,
    state: {
      setFilters: "invalid action",
      filtersByServer: {
        "https://server": { draft: "Saved draft", query: 2, source: null, extra: true },
        "https://broken-server": [],
        "invalid-server": { draft: "Invalid" },
        "file:///tmp/server": { query: "Invalid" },
      },
    },
  }));
  await store.persist.rehydrate();
  expect(store.getState().filtersByServer).toEqual({
    "https://server": { draft: "Saved draft", query: "", source: "" },
  });
  store.getState().setFilters("https://server", { query: "Saved draft" });
  expect(store.getState().filtersByServer["https://server"]!.query).toBe("Saved draft");
});

it("migrates unversioned filter storage to version one", async () => {
  values.set(STORAGE_KEY, JSON.stringify({
    version: 0,
    state: { filtersByServer: { "https://server": { draft: "Saved", query: "Saved", source: "source" } } },
  }));
  const store = (await import("./content-server-browse")).useContentServerBrowseStore;
  expect(store.getState().filtersByServer["https://server"]!.source).toBe("source");
  expect(JSON.parse(values.get(STORAGE_KEY)!)).toMatchObject({ version: 1 });
});

it.each([
  JSON.stringify({ version: 1, state: { filtersByServer: [] } }),
  JSON.stringify({ version: 1, state: null }),
  JSON.stringify({ version: 2, state: { filtersByServer: { "https://server": { query: "Future" } } } }),
  "{invalid json",
])("starts with empty filters for unsupported or malformed storage: %s", async saved => {
  values.set(STORAGE_KEY, saved);
  const store = (await import("./content-server-browse")).useContentServerBrowseStore;
  expect(store.getState().filtersByServer).toEqual({});
  store.getState().setFilters("https://server", { query: "Recovered" });
  expect(JSON.parse(values.get(STORAGE_KEY)!)).toMatchObject({
    version: 1,
    state: { filtersByServer: { "https://server": { query: "Recovered" } } },
  });
});
