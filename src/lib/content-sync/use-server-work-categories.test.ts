import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: null as null | { queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<unknown> }, data: undefined as unknown, list: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<unknown> }) => { mocks.query = options; return { data: mocks.data }; },
}));
vi.mock("../../db/user-state", () => ({ listUserWorkCategories: mocks.list }));

import { useServerWorkCategories } from "./use-server-work-categories";

const works = [
  { pluginId: "plugin", novelId: "a", novelPath: "/a", name: "ignored" },
  { pluginId: "plugin", novelId: "", novelPath: "/b" },
];

beforeEach(() => { mocks.query = null; mocks.data = undefined; mocks.list.mockReset(); });

it("looks up the listed identities under the category query prefix and answers per work", async () => {
  mocks.data = [{ pluginId: "plugin", novelPath: "/a", categories: ["Later"] }];
  const categoriesOf = useServerWorkCategories("http://server", works);
  const lookups = [{ pluginId: "plugin", novelId: "a", novelPath: "/a" }, { pluginId: "plugin", novelId: "", novelPath: "/b" }];
  expect(mocks.query).toMatchObject({ queryKey: ["category", "server-works", "http://server", lookups], enabled: true });
  await mocks.query!.queryFn();
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith("http://server", lookups);
  expect(categoriesOf("plugin", "/a")).toEqual(["Later"]);
  expect(categoriesOf("plugin", "/b")).toEqual([]);
});

it.each([
  ["no server", "", works, true],
  ["no works", "http://server", [], true],
  ["an inactive page", "http://server", works, false],
])("stays idle with %s", (_label, server, listed, enabled) => {
  useServerWorkCategories(server, listed, enabled);
  expect(mocks.query!.enabled).toBe(false);
});
