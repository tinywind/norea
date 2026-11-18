import { beforeEach, expect, it, vi } from "vitest";
import type { WorkOverrideV1 } from "../work-metadata/override";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  request: vi.fn(),
  fetch: vi.fn(),
  novels: new Map<string, { id: number; sourceNovelId: string | null; pluginId: string; path: string; isLocal: boolean }>(),
  overrides: [] as Array<{ novelId: number; isLocal: boolean; document: WorkOverrideV1 }>,
  localCover: null as null | { fileName: string; contentType: string; bytes: Uint8Array },
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
  getNovelOverride: vi.fn(async (novelId: number) => mocks.overrides.find(item => item.novelId === novelId)?.document ?? null),
  listNovelOverrides: vi.fn(async () => mocks.overrides),
  readNovelOverrideCover: vi.fn(async () => mocks.localCover),
  mergeNovelOverride: mocks.merge,
}));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => mocks.settings } }));
vi.mock("./client", async original => ({
  ...await original<typeof import("./client")>(),
  contentServerRequest: mocks.request,
  contentServerFetch: mocks.fetch,
}));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device-key") }));
vi.mock("./novel-source", () => ({ readServerNovelSource: vi.fn(async () => mocks.serverSource) }));
vi.mock("./works", () => ({ contentWorkId: vi.fn(async (identity: { pluginId: string; novelPath: string }) => `id:${identity.pluginId}:${identity.novelPath}`) }));

import { ContentServerError } from "./client";
import {
  getWorkOverrideSyncCursor, pullWorkOverride, pullWorkOverrideOnOpen, resetWorkOverrideSupportForTests,
  serverSupportsOverrideChangeCursor, serverSupportsWorkOverrides, syncWorkOverrides,
} from "./work-overrides";

const identity = (name: string) => ({ pluginId: "plugin", novelId: name, novelPath: `/${name}` });
const override = (name: string, status: string | null, updatedAt: number): WorkOverrideV1 =>
  ({ schemaVersion: 1, identity: identity(name), fields: { status: { value: status, updatedAt } } });
const novel = (id: number, name: string) => {
  const row = { id, sourceNovelId: name, pluginId: "plugin", path: `/${name}`, isLocal: false };
  mocks.novels.set(JSON.stringify(["plugin", `/${name}`]), row);
  return row;
};
const requests = () => mocks.request.mock.calls.map(([, path, , method]) => `${method} ${path}`);

beforeEach(() => {
  resetWorkOverrideSupportForTests();
  mocks.cache.clear(); mocks.novels.clear(); mocks.overrides = []; mocks.localCover = null; mocks.serverSource = null;
  mocks.request.mockReset(); mocks.fetch.mockReset(); mocks.merge.mockReset();
});

function server(options: { supported?: boolean; supportCover?: boolean; pages?: unknown[]; put?: (path: string, body: WorkOverrideV1) => unknown; get?: (path: string) => unknown }) {
  const pages = [...(options.pages ?? [{ items: [], cursor: 0, hasMore: false }])];
  mocks.request.mockImplementation(async (_server: string, path: string, _token: unknown, method: string, body: WorkOverrideV1) => {
    if (path === "/capabilities") {
      if (options.supported === false) return {};
      return {
        workOverrideVersion: 1,
        ...(options.supportCover === false ? {} : { workOverrideCoverVersion: 1 }),
      };
    }
    if (path.startsWith("/work-overrides?")) return pages.shift() ?? { items: [], cursor: Number(/after=(\d+)/.exec(path)![1]), hasMore: false };
    if (method === "PUT") return options.put!(path, body);
    return options.get!(path);
  });
}

it("keeps overrides on this device when the server does not advertise them", async () => {
  server({ supported: false });
  mocks.overrides = [{ novelId: 1, isLocal: false, document: override("a", "Completed", 5) }];
  await syncWorkOverrides("http://server", "token");
  expect(await serverSupportsWorkOverrides("http://server")).toBe(false);
  expect(requests()).toEqual(["GET /capabilities"]);
  expect(await pullWorkOverride("http://server", "token", 1, "id:plugin:/a")).toBe(false);
});

it("reads changed overrides into the works it has, then sends only what the server has not seen", async () => {
  novel(1, "a"); novel(2, "b");
  const remoteA = override("a", "Completed", 10);
  server({
    pages: [
      { items: [{ workId: "id:plugin:/a", revision: 3, override: remoteA }, { workId: "id:plugin:/missing", revision: 4, override: override("missing", "Completed", 1) }], cursor: 4, hasMore: true },
      { items: [], cursor: 4, hasMore: false },
    ],
    put: (_path, body) => ({ revision: 5, override: body }),
  });
  mocks.merge.mockResolvedValue({ document: remoteA, changed: true });
  mocks.overrides = [
    { novelId: 1, isLocal: false, document: remoteA },
    { novelId: 2, isLocal: false, document: override("b", "Ongoing", 7) },
    { novelId: 9, isLocal: true, document: { ...override("local", "Completed", 1), identity: { pluginId: "local", novelId: "x", novelPath: "/local" } } },
    { novelId: 8, isLocal: false, document: { ...override("nosource", "Completed", 1), identity: { pluginId: "plugin", novelId: "", novelPath: "/nosource" } } },
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
  const local = override("a", "Completed", 5);
  const merged: WorkOverrideV1 = { ...local, fields: { status: { value: "Ongoing", updatedAt: 9 } } };
  server({
    put: (path) => {
      if (path.includes("/b/")) throw new ContentServerError(404);
      return { revision: 7, override: merged };
    },
  });
  mocks.merge.mockResolvedValue({ document: merged, changed: true });
  mocks.overrides = [{ novelId: 1, isLocal: false, document: local }, { novelId: 2, isLocal: false, document: override("b", "Completed", 1) }];
  await syncWorkOverrides("http://server", "token");
  expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(1, merged);
  const cache = JSON.parse(mocks.cache.get("norea-content-overrides:http://server")!) as { synced: Record<string, string> };
  expect(Object.keys(cache.synced)).toEqual(["id:plugin:/a"]);
});

it("downloads and uploads cover.override bytes when workOverrideCoverVersion is 1", async () => {
  novel(1, "a"); novel(2, "b");
  const remoteCoverDoc: WorkOverrideV1 = {
    schemaVersion: 1,
    identity: identity("a"),
    fields: { cover: { value: "cover.override.png", updatedAt: 20 } },
  };
  const localDocB: WorkOverrideV1 = {
    schemaVersion: 1,
    identity: identity("b"),
    fields: {
      cover: { value: "cover.override.webp", updatedAt: 30 },
      name: { value: "Custom B", updatedAt: 30 },
    },
  };
  mocks.localCover = {
    fileName: "cover.override.webp",
    contentType: "image/webp",
    bytes: new Uint8Array([4, 5, 6]),
  };
  server({
    pages: [
      { items: [{ workId: "id:plugin:/a", revision: 2, override: remoteCoverDoc }], cursor: 2, hasMore: false },
    ],
    put: (_path, body) => ({ revision: 3, override: body }),
  });
  mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
    if (init?.method === "PUT") {
      return new Response(JSON.stringify({ revision: 3, override: { ...localDocB, fields: { cover: localDocB.fields.cover } } }), { status: 200 });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } });
  });
  mocks.merge.mockResolvedValue({ document: remoteCoverDoc, changed: true });
  mocks.overrides = [{ novelId: 2, isLocal: false, document: localDocB }];

  await syncWorkOverrides("http://server", "token");
  expect(mocks.merge).toHaveBeenCalledWith(1, remoteCoverDoc, new Uint8Array([1, 2, 3]));
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.fetch.mock.calls[0]![0]).toBe("http://server/api/v1/works/id%3Aplugin%3A%2Fa/override/cover");
  expect(mocks.fetch.mock.calls[1]![0]).toBe("http://server/api/v1/works/id%3Aplugin%3A%2Fb/override/cover?fileName=cover.override.webp&updatedAt=30");
  expect(requests()).toContain("PUT /works/id:plugin:/b/override");
});

it("does not send local overrides during a read-only pass", async () => {
  server({});
  mocks.overrides = [{ novelId: 1, isLocal: false, document: override("a", "Completed", 5) }];
  await syncWorkOverrides("http://server", "token", false);
  expect(requests()).toEqual(["GET /capabilities", "GET /work-overrides?after=0&limit=100"]);
});

it("rejects a server override whose identity belongs to another work", async () => {
  server({ pages: [{ items: [{ workId: "id:plugin:/a", revision: 1, override: override("b", "Completed", 1) }], cursor: 1, hasMore: false }] });
  await expect(syncWorkOverrides("http://server", "token")).rejects.toThrow("identity does not match");
});

it("reads one work's override when it is opened, through its bound server", async () => {
  const row = novel(1, "a");
  mocks.serverSource = { serverUrl: "http://bound", workId: "bound-work" };
  const remote = { ...override("a", "Completed", 3) };
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

it("dispatches norea-content-state-changed when remote overrides apply and reports override cursor support", async () => {
  const originalWindow = globalThis.window;
  const fakeWindow = new EventTarget();
  const dispatched = vi.fn();
  fakeWindow.addEventListener("norea-content-state-changed", dispatched);
  globalThis.window = fakeWindow as unknown as Window & typeof globalThis;
  try {
    novel(1, "a");
    const remoteA = override("a", "Completed", 10);
    mocks.request.mockImplementation(async (_server: string, path: string) => {
      if (path === "/capabilities") {
        return { workOverrideVersion: 1, workOverrideCoverVersion: 1, changeOverrideCursorVersion: 1 };
      }
      if (path.startsWith("/work-overrides?after=0&")) {
        return { items: [{ workId: "id:plugin:/a", revision: 9, override: remoteA }], cursor: 9, hasMore: false };
      }
      return { items: [], cursor: 9, hasMore: false };
    });
    mocks.merge.mockResolvedValue({ document: remoteA, changed: true });

    await syncWorkOverrides("http://server", "token");
    expect(dispatched).toHaveBeenCalledOnce();
    expect(await serverSupportsOverrideChangeCursor("http://server")).toBe(true);
    expect(await getWorkOverrideSyncCursor("http://server")).toBe(9);
  } finally {
    globalThis.window = originalWindow;
  }
});
