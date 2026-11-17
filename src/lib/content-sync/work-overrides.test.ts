import { beforeEach, expect, it, vi } from "vitest";
import type { WorkOverrideV1 } from "../work-metadata/override";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  request: vi.fn(),
  novels: new Map<string, { id: number; sourceNovelId: string | null; pluginId: string; path: string; isLocal: boolean }>(),
  overrides: [] as Array<{ novelId: number; isLocal: boolean; document: unknown }>,
  merge: vi.fn(),
  serverSource: null as null | { serverUrl: string; workId: string },
  settings: { serverUrl: "http://server", deviceName: "Tablet", lookupTimeoutSeconds: 3 },
}));
vi.mock("../../db/queries/content-sync", () => ({
  readContentSyncCache: vi.fn(async (key: string) => mocks.cache.get(key) ?? null),
  writeContentSyncCache: vi.fn(async (key: string, value: string) => { mocks.cache.set(key, value); }),
}));
vi.mock("../../db/queries/novel", () => ({
  findNovelBySource: vi.fn(async (pluginId: string, path: string) => mocks.novels.get(JSON.stringify([pluginId, path])) ?? null),
  getNovelById: vi.fn(async (id: number) => [...mocks.novels.values()].find(novel => novel.id === id) ?? null),
}));
vi.mock("../../db/queries/novel-override", () => ({
  listNovelOverrides: vi.fn(async () => mocks.overrides),
  mergeNovelOverride: mocks.merge,
}));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => mocks.settings } }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: mocks.request }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device-key") }));
vi.mock("./novel-source", () => ({ readServerNovelSource: vi.fn(async () => mocks.serverSource) }));
vi.mock("./works", () => ({ contentWorkId: vi.fn(async (identity: { pluginId: string; novelPath: string }) => `id:${identity.pluginId}:${identity.novelPath}`) }));

import { ContentServerError } from "./client";
import {
  pullWorkOverride, pullWorkOverrideOnOpen, resetWorkOverrideSupportForTests, serverSupportsWorkOverrides, syncWorkOverrides,
} from "./work-overrides";

const identity = (name: string) => ({ pluginId: "plugin", novelId: name, novelPath: `/${name}` });
const override = (name: string, completed: boolean | null, updatedAt: number): WorkOverrideV1 =>
  ({ schemaVersion: 1, identity: identity(name), fields: { completed: { value: completed, updatedAt } } });
const novel = (id: number, name: string) => {
  const row = { id, sourceNovelId: name, pluginId: "plugin", path: `/${name}`, isLocal: false };
  mocks.novels.set(JSON.stringify(["plugin", `/${name}`]), row);
  return row;
};
const requests = () => mocks.request.mock.calls.map(([, path, , method]) => `${method} ${path}`);

beforeEach(() => {
  resetWorkOverrideSupportForTests();
  mocks.cache.clear(); mocks.novels.clear(); mocks.overrides = []; mocks.serverSource = null;
  mocks.request.mockReset(); mocks.merge.mockReset();
});

function server(options: { supported?: boolean; pages?: unknown[]; put?: (path: string, body: WorkOverrideV1) => unknown; get?: (path: string) => unknown }) {
  const pages = [...(options.pages ?? [{ items: [], cursor: 0, hasMore: false }])];
  mocks.request.mockImplementation(async (_server: string, path: string, _token: unknown, method: string, body: WorkOverrideV1) => {
    if (path === "/capabilities") return options.supported === false ? {} : { workOverrideVersion: 1 };
    if (path.startsWith("/work-overrides?")) return pages.shift() ?? { items: [], cursor: Number(/after=(\d+)/.exec(path)![1]), hasMore: false };
    if (method === "PUT") return options.put!(path, body);
    return options.get!(path);
  });
}

it("keeps overrides on this device when the server does not advertise them", async () => {
  server({ supported: false });
  mocks.overrides = [{ novelId: 1, isLocal: false, document: override("a", true, 5) }];
  await syncWorkOverrides("http://server", "token");
  expect(await serverSupportsWorkOverrides("http://server")).toBe(false);
  expect(requests()).toEqual(["GET /capabilities"]);
  expect(await pullWorkOverride("http://server", "token", 1, "id:plugin:/a")).toBe(false);
});

it("reads changed overrides into the works it has, then sends only what the server has not seen", async () => {
  novel(1, "a"); novel(2, "b");
  const remoteA = override("a", true, 10);
  server({
    pages: [
      { items: [{ workId: "id:plugin:/a", revision: 3, override: remoteA }, { workId: "id:plugin:/missing", revision: 4, override: override("missing", true, 1) }], cursor: 4, hasMore: true },
      { items: [], cursor: 4, hasMore: false },
    ],
    put: (_path, body) => ({ revision: 5, override: body }),
  });
  mocks.merge.mockResolvedValue({ document: remoteA, changed: true });
  mocks.overrides = [
    { novelId: 1, isLocal: false, document: remoteA },
    { novelId: 2, isLocal: false, document: override("b", false, 7) },
    { novelId: 9, isLocal: true, document: { ...override("local", true, 1), identity: { pluginId: "local", novelId: "x", novelPath: "/local" } } },
    { novelId: 8, isLocal: false, document: { ...override("nosource", true, 1), identity: { pluginId: "plugin", novelId: "", novelPath: "/nosource" } } },
  ];
  await syncWorkOverrides("http://server", "token");
  expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(1, remoteA);
  expect(requests()).toEqual([
    "GET /capabilities", "GET /work-overrides?after=0&limit=100", "GET /work-overrides?after=4&limit=100", "PUT /works/id:plugin:/b/override",
  ]);
  const cache = JSON.parse(mocks.cache.get("norea-content-overrides:http://server")!) as { cursor: number; synced: Record<string, string> };
  expect(cache.cursor).toBe(4);
  expect(Object.keys(cache.synced).sort()).toEqual(["id:plugin:/a", "id:plugin:/b"]);

  mocks.request.mockClear();
  await syncWorkOverrides("http://server", "token");
  expect(requests()).toEqual(["GET /work-overrides?after=4&limit=100"]);
});

it("absorbs the server's newer fields after sending and leaves works the server lacks for later", async () => {
  novel(1, "a"); novel(2, "b");
  const local = override("a", true, 5);
  const merged: WorkOverrideV1 = { ...local, fields: { completed: { value: false, updatedAt: 9 } } };
  server({
    put: (path) => {
      if (path.includes("/b/")) throw new ContentServerError(404);
      return { revision: 7, override: merged };
    },
  });
  mocks.merge.mockResolvedValue({ document: merged, changed: true });
  mocks.overrides = [{ novelId: 1, isLocal: false, document: local }, { novelId: 2, isLocal: false, document: override("b", true, 1) }];
  await syncWorkOverrides("http://server", "token");
  expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(1, merged);
  const cache = JSON.parse(mocks.cache.get("norea-content-overrides:http://server")!) as { synced: Record<string, string> };
  expect(Object.keys(cache.synced)).toEqual(["id:plugin:/a"]);
});

it("does not send local overrides during a read-only pass", async () => {
  server({});
  mocks.overrides = [{ novelId: 1, isLocal: false, document: override("a", true, 5) }];
  await syncWorkOverrides("http://server", "token", false);
  expect(requests()).toEqual(["GET /capabilities", "GET /work-overrides?after=0&limit=100"]);
});

it("rejects a server override whose identity belongs to another work", async () => {
  server({ pages: [{ items: [{ workId: "id:plugin:/a", revision: 1, override: override("b", true, 1) }], cursor: 1, hasMore: false }] });
  await expect(syncWorkOverrides("http://server", "token")).rejects.toThrow("identity does not match");
});

it("reads one work's override when it is opened, through its bound server", async () => {
  const row = novel(1, "a");
  mocks.serverSource = { serverUrl: "http://bound", workId: "bound-work" };
  const remote = { ...override("a", true, 3) };
  server({ get: () => ({ revision: 2, override: remote }) });
  mocks.request.mockImplementation(async (_server: string, path: string) =>
    path === "/capabilities" ? { workOverrideVersion: 1 } : { revision: 2, override: remote });
  // The bound work id is what the server knows the work by.
  const works = await import("./works");
  vi.mocked(works.contentWorkId).mockResolvedValueOnce("bound-work");
  mocks.merge.mockResolvedValue({ document: remote, changed: true });
  expect(await pullWorkOverrideOnOpen(row.id)).toBe(true);
  expect(mocks.request.mock.calls.at(-1)!.slice(0, 2)).toEqual(["http://bound", "/works/bound-work/override"]);

  mocks.request.mockImplementation(async (_server: string, path: string) => {
    if (path === "/capabilities") return { workOverrideVersion: 1 };
    throw new ContentServerError(404);
  });
  expect(await pullWorkOverrideOnOpen(row.id)).toBe(false);
});
