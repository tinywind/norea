import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { load } from "cheerio";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ChapterMediaElementPatch } from "../../lib/chapter-media";

type MediaListener = (event: { chapterId: number; patches: ChapterMediaElementPatch[] }) => void;
type PartialListener = (event: { chapterId: number; html: string }) => void;
const subscriptions = vi.hoisted(() => ({ media: new Set<MediaListener>(), partial: new Set<PartialListener>() }));
vi.mock("../../lib/tasks/chapter-download", () => ({
  subscribeChapterDownloads: () => () => undefined,
  subscribeChapterPartialContentUpdates: (listener: PartialListener) => {
    subscriptions.partial.add(listener);
    return () => subscriptions.partial.delete(listener);
  },
  subscribeChapterMediaPatches: (listener: MediaListener) => {
    subscriptions.media.add(listener);
    return () => subscriptions.media.delete(listener);
  },
}));
vi.mock("../../lib/chapter-media", async original => ({
  ...await original<typeof import("../../lib/chapter-media")>(),
  resolveLocalChapterMediaPatches: vi.fn(async (patches: ChapterMediaElementPatch[]) => patches),
}));

vi.mock("../../db/queries/chapter", () => ({
  getChapterById: vi.fn(),
  markChapterOpened: vi.fn().mockResolvedValue(undefined),
  updateChapterProgress: vi.fn().mockResolvedValue(undefined),
}));

import { markChapterOpened } from "../../db/queries/chapter";
import { useReaderStore } from "../../store/reader";
import { resolveLocalChapterMediaPatches } from "../../lib/chapter-media";
import { useReaderPersistence } from "./use-reader-persistence";
import { useReaderChapterDocument } from "./use-reader-chapter-document";

let root: Root | undefined;
const queryClient = new QueryClient();

function mountNullRenderer() {
  const document = {
    nodeType: 9, activeElement: null, body: null as unknown,
    documentElement: { nodeName: "HTML" },
    createElement() {
      let html = "";
      return {
        set innerHTML(value: string) { html = value; },
        get content() {
          const $ = load(html);
          return { textContent: $.root().text(), querySelector: (selector: string) => $(selector).get(0) };
        },
      };
    },
    addEventListener() {}, removeEventListener() {},
  };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "",
    addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    document, HTMLIFrameElement: class {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return createRoot(container as unknown as Element);
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  subscriptions.media.clear();
  subscriptions.partial.clear();
  queryClient.clear();
  useReaderStore.setState({ lastReadChapterByNovel: {} });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("enables progress and history for a saved body with incomplete media after rejecting streamed content", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  let current: ReturnType<typeof useReaderChapterDocument> | undefined;
  const openedChapterRef = { current: null as number | null };
  const chapter = {
    id: 31, novelId: 37, name: "Incomplete media", chapterNumber: "1", position: 1,
    contentType: "html" as const, isDownloaded: false,
  };
  const novel = { id: 37, name: "Stored work", path: "/work", pluginId: "source", sourceNovelId: "work" };
  const contentRef = { current: null };
  function Probe({ content }: { content: string | null }) {
    const storedChapter = { ...chapter, content, mediaRepairNeeded: content !== null };
    useReaderPersistence(storedChapter, openedChapterRef);
    current = useReaderChapterDocument({
      chapterId: chapter.id, chapter: storedChapter, currentNovel: novel, bionicReading: false, contentRef,
    });
    return null;
  }
  const render = (content: string | null) => act(async () => {
    root!.render(<QueryClientProvider client={queryClient}><Probe content={content} /></QueryClientProvider>);
  });
  await render(null);
  await act(async () => {
    for (const listener of subscriptions.partial) listener({ chapterId: chapter.id, html: "<p>Streaming body</p>" });
  });
  expect(current!.content).toBe("<p>Streaming body</p>");
  expect(current!.readerProgressPersistenceReady).toBe(false);
  expect(current!.showMediaRepair).toBe(false);
  expect(markChapterOpened).not.toHaveBeenCalled();
  expect(useReaderStore.getState().lastReadChapterByNovel[chapter.novelId]).toBeUndefined();

  await render("<p>Saved final body</p>");
  expect(current!.content).toBe("<p>Saved final body</p>");
  expect(current!.readerProgressPersistenceReady).toBe(true);
  expect(current!.showMediaRepair).toBe(true);
  expect(markChapterOpened).toHaveBeenCalledExactlyOnceWith(chapter.id);
  expect(useReaderStore.getState().lastReadChapterByNovel[chapter.novelId]).toBe(chapter.id);
});

it("uses the plugin novel ID for reader media and refreshes both context and patch subscriptions when it changes", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  let current: ReturnType<typeof useReaderChapterDocument> | undefined;
  const chapter = {
    id: 11, novelId: 17, name: "Side story", chapterNumber: "1.5", position: 2,
    content: null, contentType: "html" as const, isDownloaded: true, mediaRepairNeeded: false,
  };
  const novel = { id: 17, name: "A title unrelated to its ID", path: "/source-route?book=42", pluginId: "source" };
  const contentRef = { current: null };
  function Probe({ sourceNovelId }: { sourceNovelId: string }) {
    current = useReaderChapterDocument({
      chapterId: 11, chapter, currentNovel: { ...novel, sourceNovelId }, bionicReading: false, contentRef,
    });
    return null;
  }
  const render = (sourceNovelId: string) => act(async () => {
    root!.render(<QueryClientProvider client={queryClient}><Probe sourceNovelId={sourceNovelId} /></QueryClientProvider>);
  });
  await render("plugin-owned-42");
  expect(current!.readerLocalMediaContext).toEqual({
    chapterId: 11, chapterName: "Side story", chapterNumber: "1.5", chapterPosition: 2,
    novelId: 17, novelName: "A title unrelated to its ID", sourceId: "source", sourceNovelId: "plugin-owned-42",
  });
  await render("updated-plugin-id");
  expect(current!.readerLocalMediaContext!.sourceNovelId).toBe("updated-plugin-id");
  expect(subscriptions.media.size).toBe(1);
  const patches: ChapterMediaElementPatch[] = [{ index: 0, attributes: { src: "norea-media://reader-asset/page.png" } }];
  await act(async () => {
    for (const listener of subscriptions.media) listener({ chapterId: 11, patches });
  });
  expect(resolveLocalChapterMediaPatches).toHaveBeenCalledExactlyOnceWith(patches, {
    chapterId: 11, chapterName: "Side story", chapterNumber: "1.5", chapterPosition: 2,
    novelId: 17, novelName: "A title unrelated to its ID", sourceId: "source", sourceNovelId: "updated-plugin-id",
  });
});
