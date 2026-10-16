import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import type { ServerWorkSummary } from "./browse";
import { removeDeletedServerWorkFromQueries } from "./management-query-cache";
import type { WorkCatalogEntry } from "./works";

const source = { serverUrl: "http://server", workId: "deleted-work" };
const entry = { id: source.workId, deleted: true, metadata: { identity: { pluginId: "plugin", novelPath: "/deleted" } } } as WorkCatalogEntry;
const work = (id: string) => ({ id }) as ServerWorkSummary;

it("removes the work from every matching catalog page and keeps pagination offsets correct", async () => {
  const client = new QueryClient();
  const key = ["content-server", source.serverUrl, "browse", "", ""];
  client.setQueryData(key, { pages: [
    { items: [work(source.workId), work("second")], total: 5, hasMore: true },
    { items: [work("third"), work("fourth")], total: 5, hasMore: true },
  ], pageParams: [0, 2] });
  client.setQueryData(["content-server", source.serverUrl, "sources"], { items: [{ id: "plugin", workCount: 1 }, { id: "other", workCount: 2 }] });
  const otherServer = ["content-server", "http://other", "browse", "", ""];
  const otherData = { pages: [{ items: [work(source.workId)], total: 1, hasMore: false }], pageParams: [0] };
  client.setQueryData(otherServer, otherData);
  const localKey = ["novel", "detail", 8];
  const local = { inLibrary: true, progress: 61, cover: "original-cover" };
  client.setQueryData(localKey, local);
  await removeDeletedServerWorkFromQueries(client, source, entry);
  expect(client.getQueryData(key)).toEqual({ pages: [
    { items: [work("second")], total: 4, hasMore: true },
    { items: [work("third"), work("fourth")], total: 4, hasMore: true },
  ], pageParams: [0, 1] });
  expect(client.getQueryData(["content-server", source.serverUrl, "sources"])).toEqual({ items: [{ id: "other", workCount: 2 }] });
  expect(client.getQueryData(otherServer)).toEqual(otherData);
  expect(client.getQueryData(localKey)).toBe(local);
  client.clear();
});

it("cancels old chapter and presence responses before clearing deleted server data", async () => {
  const client = new QueryClient();
  const presence = ["content-server", "manage-work", source.serverUrl, "plugin", "/deleted"];
  const chapters = ["content-server", source.serverUrl, "managed-chapters", source.workId, 1];
  const availability = ["content-server", "novel-chapters", source.serverUrl, source.workId];
  const cover = ["content-server", source.serverUrl, "cover", source.workId, 1];
  client.setQueryData(presence, source);
  client.setQueryData(chapters, { items: [{ id: "chapter" }], total: 1, hasMore: false });
  client.setQueryData(availability, { paths: new Set(["/chapter"]), numbers: new Set([1]) });
  client.setQueryData(cover, "old-cover");
  let release!: (value: typeof source) => void;
  let aborted = false;
  const oldRequest = client.fetchQuery({ queryKey: presence, queryFn: ({ signal }) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise<typeof source>(resolve => { release = resolve; });
  } }).catch(() => undefined);
  await removeDeletedServerWorkFromQueries(client, source, entry);
  expect(aborted).toBe(true);
  release(source);
  await oldRequest;
  expect(client.getQueryData(presence)).toBeNull();
  expect(client.getQueryData(chapters)).toEqual({ items: [], total: 0, hasMore: false });
  expect(client.getQueryData(availability)).toEqual({ paths: new Set(), numbers: new Set() });
  expect(client.getQueryData(cover)).toBeUndefined();
  client.clear();
});
