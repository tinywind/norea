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
    categories: ["cat-1"],
    draft: "QA Server ",
    query: "QA Server",
    source: "qa-source",
    statuses: ["Completed", "On Hiatus"],
    tags: ["Fantasy"],
    uncategorized: true,
  });
  first.getState().setFilters("https://other-server", { draft: "Other", query: "Other" });
  expect(JSON.parse(values.get(STORAGE_KEY)!)).toMatchObject({ version: 2 });

  vi.resetModules();
  const restored = (await import("./content-server-browse")).useContentServerBrowseStore;
  expect(restored).not.toBe(first);
  expect(restored.getState().filtersByServer).toEqual({
    "http://server": {
      categories: ["cat-1"],
      draft: "QA Server ",
      query: "QA Server",
      source: "qa-source",
      statuses: ["Completed", "On Hiatus"],
      tags: ["Fantasy"],
      uncategorized: true,
    },
    "https://other-server": {
      categories: [],
      draft: "Other",
      query: "Other",
      source: "",
      statuses: [],
      tags: [],
      uncategorized: false,
    },
  });
  restored.getState().setFilters("http://server", { source: "new-source" });
  expect(restored.getState().filtersByServer["https://other-server"]!.query).toBe("Other");
});

it("validates rehydrated fields and never replaces store actions from storage", async () => {
  const store = (await import("./content-server-browse")).useContentServerBrowseStore;
  values.set(STORAGE_KEY, JSON.stringify({
    version: 2,
    state: {
      setFilters: "invalid action",
      filtersByServer: {
        "https://server": {
          categories: ["cat-1", "", "cat-1", 42],
          draft: "Saved draft",
          extra: true,
          query: 2,
          source: null,
          statuses: ["Ongoing", "Unknown", "Licensed", "Publishing Finished", "Ongoing"],
          tags: ["#Fantasy", "fantasy", "Drama", "  "],
          uncategorized: "yes",
        },
        "https://broken-server": [],
        "invalid-server": { draft: "Invalid" },
        "file:///tmp/server": { query: "Invalid" },
      },
    },
  }));
  await store.persist.rehydrate();
  expect(store.getState().filtersByServer).toEqual({
    "https://server": {
      categories: ["cat-1"],
      draft: "Saved draft",
      query: "",
      source: "",
      statuses: ["Ongoing"],
      tags: ["Fantasy", "Drama"],
      uncategorized: false,
    },
  });
  store.getState().setFilters("https://server", { query: "Saved draft" });
  expect(store.getState().filtersByServer["https://server"]!.query).toBe("Saved draft");
});

it("migrates older filter storage to version two", async () => {
  values.set(STORAGE_KEY, JSON.stringify({
    version: 1,
    state: { filtersByServer: { "https://server": { completion: "completed", draft: "Saved", query: "Saved", source: "source" } } },
  }));
  const store = (await import("./content-server-browse")).useContentServerBrowseStore;
  expect(store.getState().filtersByServer["https://server"]).toEqual({
    categories: [],
    draft: "Saved",
    query: "Saved",
    source: "source",
    statuses: [],
    tags: [],
    uncategorized: false,
  });
  expect(JSON.parse(values.get(STORAGE_KEY)!)).toMatchObject({ version: 2 });
});

it.each([
  JSON.stringify({ version: 2, state: { filtersByServer: [] } }),
  JSON.stringify({ version: 2, state: null }),
  JSON.stringify({ version: 3, state: { filtersByServer: { "https://server": { query: "Future" } } } }),
  "{invalid json",
])("starts with empty filters for unsupported or malformed storage: %s", async saved => {
  values.set(STORAGE_KEY, saved);
  const store = (await import("./content-server-browse")).useContentServerBrowseStore;
  expect(store.getState().filtersByServer).toEqual({});
  store.getState().setFilters("https://server", { query: "Recovered" });
  expect(JSON.parse(values.get(STORAGE_KEY)!)).toMatchObject({
    version: 2,
    state: { filtersByServer: { "https://server": { query: "Recovered" } } },
  });
});
