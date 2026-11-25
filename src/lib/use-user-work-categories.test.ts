import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  listUserWorkCategories: vi.fn(),
  query: undefined as Record<string, unknown> | undefined,
  serverUrl: "",
}));

vi.mock("react", () => ({
  useCallback: <T,>(fn: T) => fn,
  useMemo: <T,>(fn: () => T) => fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    mocks.query = options;
    return { data: mocks.data };
  },
}));
vi.mock("../db/user-state", () => ({
  listUserWorkCategories: (...args: unknown[]) =>
    mocks.listUserWorkCategories(...args),
}));
vi.mock("../store/content-sync", () => ({
  useContentSyncStore: (selector: (state: { serverUrl: string }) => unknown) =>
    selector({ serverUrl: mocks.serverUrl }),
}));

import {
  normalizeWorkCategoryLookups,
  useUserWorkCategories,
} from "./use-user-work-categories";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = undefined;
  mocks.query = undefined;
  mocks.serverUrl = "";
});

describe("normalizeWorkCategoryLookups", () => {
  it("deduplicates targets by plugin and path while keeping a known novelId", () => {
    expect(
      normalizeWorkCategoryLookups([
        { pluginId: "bookkor", novelPath: "/novel/1" },
        { pluginId: "bookkor", novelId: "1", novelPath: "/novel/1" },
        { pluginId: "bookkor", novelPath: "/novel/1" },
        { pluginId: "", novelPath: "/ignored" },
        { pluginId: "ridi", novelPath: "/books/2" },
      ]),
    ).toEqual([
      { pluginId: "bookkor", novelId: "1", novelPath: "/novel/1" },
      { pluginId: "ridi", novelId: "", novelPath: "/books/2" },
    ]);
  });
});

describe("useUserWorkCategories", () => {
  it("stays enabled without a content server so local categories still load", async () => {
    const works = [{ pluginId: "bookkor", novelPath: "/novel/1" }];
    mocks.data = [{ pluginId: "bookkor", novelPath: "/novel/1", categories: ["Local"] }];

    const categoriesOf = useUserWorkCategories(works);

    expect(mocks.query).toMatchObject({
      enabled: true,
      networkMode: "always",
      queryKey: [
        "category",
        "user-works",
        "",
        [{ pluginId: "bookkor", novelId: "", novelPath: "/novel/1" }],
      ],
    });
    expect(categoriesOf("bookkor", "/novel/1")).toEqual(["Local"]);
    expect(categoriesOf("bookkor", "/novel/other")).toEqual([]);

    await (mocks.query!.queryFn as () => Promise<unknown>)();
    expect(mocks.listUserWorkCategories).toHaveBeenCalledWith("", [
      { pluginId: "bookkor", novelId: "", novelPath: "/novel/1" },
    ]);
  });

  it("passes the configured content server URL so synced server categories resolve", async () => {
    mocks.serverUrl = "https://sync.example";
    const works = [{ pluginId: "bookkor", novelPath: "/novel/8256" }];
    mocks.data = [
      {
        pluginId: "bookkor",
        novelPath: "/novel/8256",
        categories: ["5 Stars", "Reading"],
      },
    ];

    const categoriesOf = useUserWorkCategories(works);

    expect(mocks.query).toMatchObject({
      enabled: true,
      queryKey: [
        "category",
        "user-works",
        "https://sync.example",
        [{ pluginId: "bookkor", novelId: "", novelPath: "/novel/8256" }],
      ],
    });
    expect(categoriesOf("bookkor", "/novel/8256")).toEqual([
      "5 Stars",
      "Reading",
    ]);

    await (mocks.query!.queryFn as () => Promise<unknown>)();
    expect(mocks.listUserWorkCategories).toHaveBeenCalledWith(
      "https://sync.example",
      [{ pluginId: "bookkor", novelId: "", novelPath: "/novel/8256" }],
    );
  });

  it.each([
    ["no works", [], true],
    ["disabled", [{ pluginId: "bookkor", novelPath: "/novel/1" }], false],
  ])("waits to query when %s", (_label, works, enabled) => {
    useUserWorkCategories(works, enabled);
    expect(mocks.query?.enabled).toBe(false);
  });
});
