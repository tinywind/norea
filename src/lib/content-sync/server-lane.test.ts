import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: null as { serverUrl: string; workId: string } | null,
  serverUrl: "http://server",
  chapters: [] as unknown[] | Error,
}));
vi.mock("../../store/content-sync", () => ({
  useContentSyncStore: { getState: () => ({ serverUrl: mocks.serverUrl, deviceName: "Phone" }) },
}));
vi.mock("./novel-source", () => ({ readServerNovelSource: async () => mocks.stored }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "token") }));
vi.mock("./works", () => ({ contentWorkId: async () => "derived-work" }));
vi.mock("./chapters", () => ({
  fetchServerChapters: vi.fn(async () => {
    if (mocks.chapters instanceof Error) throw mocks.chapters;
    return mocks.chapters;
  }),
}));

import { fetchServerChapters } from "./chapters";
import { planServerLaneJobs } from "./server-lane";

const job = (id: number, chapterNumber?: string) =>
  ({ id, pluginId: "source", chapterPath: `/c/${id}`, chapterNumber, title: `Chapter ${id}` });
const novel = { id: 1, pluginId: "source", path: "/book" };
const listed = (chapterPath: string, chapterNumber: string | null, complete: boolean) => ({ chapterPath, chapterNumber, complete });

beforeEach(() => {
  mocks.stored = null;
  mocks.serverUrl = "http://server";
  mocks.chapters = [];
  vi.clearAllMocks();
});

it("routes chapters the server lists as complete through the server lane", async () => {
  mocks.chapters = [
    listed("/c/1", "1", true), listed("/c/2", "2", false), listed("/server/3", "3", true),
    listed("/server/4a", "4", true), listed("/server/4b", "4", true),
  ];
  const planned = await planServerLaneJobs(novel, [job(1, "1"), job(2, "2"), job(3, "3"), job(4, "4"), job(5, "5")],
    new AbortController().signal);

  expect(planned.map((row) => [row.id, row.serverLane ?? false])).toEqual([
    [1, true], [2, false], [3, true], [4, false], [5, false],
  ]);
  expect(fetchServerChapters).toHaveBeenCalledWith({ serverUrl: "http://server", workId: "derived-work" }, "token", expect.anything());
});

it("lists the work a server-installed novel came from", async () => {
  mocks.stored = { serverUrl: "http://origin", workId: "origin-work" };
  await planServerLaneJobs(novel, [job(1)], new AbortController().signal);
  expect(fetchServerChapters).toHaveBeenCalledWith({ serverUrl: "http://origin", workId: "origin-work" }, "token", expect.anything());
});

it("keeps the per-chapter lookup when no server is configured or the listing fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.serverUrl = "";
  expect(await planServerLaneJobs(novel, [job(1)], new AbortController().signal)).toEqual([job(1)]);
  expect(fetchServerChapters).not.toHaveBeenCalled();

  mocks.serverUrl = "http://server";
  mocks.chapters = new Error("Server chapter catalog did not advance.");
  expect(await planServerLaneJobs(novel, [job(1)], new AbortController().signal)).toEqual([job(1)]);
});
