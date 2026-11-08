import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queue: vi.fn(), show: vi.fn(), binding: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.show } }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/content-sync/novel-source", () => ({ readServerNovelSource: mocks.binding }));
vi.mock("../library/download-once", () => ({
  queueChapterDownloadsOnce: mocks.queue,
  downloadOnceNotice: (_t: unknown, result: { queued: number }) => ({ color: result.queued > 0 ? "ok" : "warn", message: `queued:${result.queued}` }),
}));

import { useNovelDownloadOnce } from "./NovelActions";
let root: Root;
let choice: ReturnType<typeof useNovelDownloadOnce>;
const onClose = vi.fn();
function Probe() { choice = useNovelDownloadOnce({ novelId: 3, onClose }); return null; }
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.queue.mockResolvedValue({ queued: 2, skippedLocal: 0 });
  mocks.binding.mockReset().mockResolvedValue(null);
  const document = { nodeType: 9, activeElement: null, body: null as unknown, documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it("submits the chosen range as one immediate request and reports the admitted chapters", async () => {
  await act(async () => choice.choose({ kind: "next", count: 5 }));
  expect(mocks.queue).toHaveBeenCalledExactlyOnceWith([3], expect.any(Function), expect.any(QueryClient), { kind: "next", count: 5 });
  expect(onClose).toHaveBeenCalledOnce();
  expect(mocks.show).toHaveBeenCalledWith({ autoClose: 3_000, color: "ok", message: "queued:2" });
});

it("does not treat a repeated range as a saved policy that needs no request", async () => {
  await act(async () => choice.choose({ kind: "all" }));
  mocks.queue.mockResolvedValueOnce({ queued: 0, skippedLocal: 0 });
  await act(async () => choice.choose({ kind: "all" }));
  expect(mocks.queue).toHaveBeenCalledTimes(2);
  expect(mocks.show).toHaveBeenLastCalledWith({ autoClose: 3_000, color: "warn", message: "queued:0" });
});

it("waits for admission before closing and keeps a failed request available to retry", async () => {
  let reject!: (error: Error) => void;
  mocks.queue.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  let pending!: Promise<void>;
  await act(async () => { pending = choice.choose({ kind: "remaining" }); });
  expect(choice.saving).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { reject(new Error("Queue publication failed")); await pending; });
  expect(choice.saving).toBe(false);
  expect(choice.error).toEqual(new Error("Queue publication failed"));
  expect(onClose).not.toHaveBeenCalled();
  expect(mocks.show).not.toHaveBeenCalled();
  await act(async () => choice.choose({ kind: "remaining" }));
  expect(choice.error).toBeNull();
  expect(onClose).toHaveBeenCalledOnce();
});


it("uses the common download path for a work remembered from the server", async () => {
  mocks.binding.mockResolvedValue({ serverUrl: "http://server", workId: "work" });
  await act(async () => choice.choose({ kind: "all" }));
  expect(mocks.binding).not.toHaveBeenCalled();
  expect(mocks.queue).toHaveBeenCalledExactlyOnceWith([3], expect.any(Function), expect.any(QueryClient), { kind: "all" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("leaves server resolution to the common downloader instead of blocking queue admission", async () => {
  mocks.binding.mockRejectedValue(new Error("Binding read failed"));
  await act(async () => choice.choose({ kind: "all" }));
  expect(mocks.binding).not.toHaveBeenCalled();
  expect(mocks.queue).toHaveBeenCalledExactlyOnceWith([3], expect.any(Function), expect.any(QueryClient), { kind: "all" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(choice.error).toBeNull();
});
