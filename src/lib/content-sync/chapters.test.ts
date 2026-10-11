import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./client", () => ({ contentServerRequest: vi.fn() }));
import { contentServerRequest } from "./client";
import { fetchServerChapters } from "./chapters";

const chapter = { id: "chapter", chapterPath: "/chapter/1", name: "One", chapterNumber: "1", position: 1, page: "1", contentType: "html" };
beforeEach(() => vi.clearAllMocks());

it("loads chapter summaries for just one work without work metadata or package downloads", async () => {
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ items: [chapter], total: 2, hasMore: true })
    .mockResolvedValueOnce({ items: [{ ...chapter, id: "two", chapterPath: "/chapter/2", chapterNumber: "2" }], total: 2, hasMore: false });
  expect(await fetchServerChapters({ serverUrl: "http://server", workId: "work" }, "token")).toHaveLength(2);
  expect(vi.mocked(contentServerRequest).mock.calls.map(call => call[1])).toEqual([
    "/catalog/works/work/chapters?offset=0&limit=100", "/catalog/works/work/chapters?offset=1&limit=100",
  ]);
});

it("rejects a partial chapter list after a later page fails", async () => {
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ items: [chapter], total: 2, hasMore: true }).mockRejectedValueOnce(new Error("offline"));
  await expect(fetchServerChapters({ serverUrl: "http://server", workId: "work" }, "token")).rejects.toThrow("offline");
});

it("rejects a response arriving after cancellation", async () => {
  const controller = new AbortController();
  vi.mocked(contentServerRequest).mockImplementationOnce(async () => {
    controller.abort();
    return { items: [chapter], total: 1, hasMore: false };
  });
  await expect(fetchServerChapters({ serverUrl: "http://server", workId: "work" }, "token", controller.signal)).rejects.toThrow();
});
