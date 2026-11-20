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
import { useReaderContentMedia } from "./use-reader-content-media";
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
          return {
            textContent: $.root().text(),
            querySelector: (selector: string) => $(selector).get(0),
            querySelectorAll: () => [],
          };
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
  expect(current!.mediaRepairAttention).toBe(false);
  expect(markChapterOpened).toHaveBeenCalledExactlyOnceWith(chapter.id);
  expect(useReaderStore.getState().lastReadChapterByNovel[chapter.novelId]).toBe(chapter.id);
});

it("flags mediaRepairAttention immediately when a media-repair chapter has zero archived media bytes", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  let current: ReturnType<typeof useReaderChapterDocument> | undefined;
  const chapter = {
    id: 41, novelId: 37, name: "Missing archive", chapterNumber: "5", position: 5,
    content: "<img src=\"norea-media://reader-asset/0001-001.jpg\" />",
    contentType: "html" as const, isDownloaded: false, mediaRepairNeeded: true, mediaBytes: 0,
  };
  const novel = { id: 37, name: "Stored work", path: "/work", pluginId: "source", sourceNovelId: "work" };
  const contentRef = { current: null };
  function Probe() {
    current = useReaderChapterDocument({
      chapterId: chapter.id, chapter, currentNovel: novel, bionicReading: false, contentRef,
    });
    return null;
  }
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
  });
  expect(current!.showMediaRepair).toBe(true);
  expect(current!.mediaRepairAttention).toBe(true);
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

it("preserves a promoted prepared chapter's replayed media error instead of clobbering it on chapter switch", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  vi.mocked(resolveLocalChapterMediaPatches).mockResolvedValue([]);
  const novel = { id: 37, name: "Stored work", path: "/work", pluginId: "source", sourceNovelId: "work" };
  const chapter1 = {
    id: 101, novelId: 37, name: "Ch 1", chapterNumber: "1", position: 1,
    content: "<p>Clean chapter 1</p>", contentType: "html" as const, mediaRepairNeeded: false,
  };
  const chapter2 = {
    id: 102, novelId: 37, name: "Ch 2", chapterNumber: "2", position: 2,
    content: '<img src="norea-media://reader-asset/missing.jpg" />',
    contentType: "html" as const, mediaRepairNeeded: false,
  };
  const chapter3 = {
    id: 103, novelId: 37, name: "Ch 3", chapterNumber: "3", position: 3,
    content: "<p>Clean chapter 3</p>", contentType: "html" as const, mediaRepairNeeded: false,
  };
  const mockChapter2Dom = {
    querySelectorAll: () => [{
      getAttribute: (name: string) =>
        name === "data-norea-reader-local-media-src"
          ? encodeURIComponent("norea-media://reader-asset/missing.jpg")
          : null,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    }],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const chapter2ContentRef = { current: mockChapter2Dom as unknown as HTMLDivElement };
  const contentRef = { current: null };
  let current: ReturnType<typeof useReaderChapterDocument> | undefined;

  function ChildMedia({
    active,
    onMediaError,
  }: {
    active: boolean;
    onMediaError?: (source: string | null) => void;
  }) {
    useReaderContentMedia({
      contentKey: "102:stored",
      renderedHtml: chapter2.content,
      localMediaContext: {
        chapterId: chapter2.id,
        chapterName: chapter2.name,
        chapterNumber: chapter2.chapterNumber,
        chapterPosition: chapter2.position,
        novelId: novel.id,
        novelName: novel.name,
        sourceNovelId: novel.sourceNovelId,
        sourceId: novel.pluginId,
      },
      contentRef: chapter2ContentRef,
      activeVirtualRangeStart: 0,
      activeVirtualRangeEnd: 0,
      isPagedReader: false,
      onMediaError: active ? onMediaError : undefined,
    });
    return null;
  }

  function ParentProbe({ activeChapter }: { activeChapter: typeof chapter1 }) {
    current = useReaderChapterDocument({
      chapterId: activeChapter.id,
      chapter: activeChapter,
      currentNovel: novel,
      bionicReading: false,
      contentRef,
    });
    return (
      <>
        {activeChapter.id === chapter2.id ? (
          <ChildMedia key="102:stored" active onMediaError={current.handleRemoteMediaError} />
        ) : null}
        {activeChapter.id === chapter1.id ? (
          <ChildMedia key="102:stored" active={false} />
        ) : null}
      </>
    );
  }

  // Step 1: Reading chapter 1 while chapter 2 prepares in the background and hits missing media.
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ParentProbe activeChapter={chapter1} />
      </QueryClientProvider>,
    );
  });
  expect(current!.remoteMediaError).toBe(false);
  expect(current!.mediaRepairAttention).toBe(false);

  // Step 2: Advance to chapter 2, promoting the prepared ChildMedia in the exact same render.
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ParentProbe activeChapter={chapter2} />
      </QueryClientProvider>,
    );
  });
  expect(current!.remoteMediaError).toBe(true);
  expect(current!.showMediaRepair).toBe(true);
  expect(current!.mediaRepairAttention).toBe(true);

  // Step 3: Advancing to clean chapter 3 clears remoteMediaError, and returning to chapter 2 starts clean.
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ParentProbe activeChapter={chapter3} />
      </QueryClientProvider>,
    );
  });
  expect(current!.remoteMediaError).toBe(false);
  expect(current!.mediaRepairAttention).toBe(false);

  vi.mocked(resolveLocalChapterMediaPatches).mockResolvedValue([
    {
      index: 0,
      attributes: { src: "http://norea-media.localhost/reader-asset/~cache/tok/missing.jpg" },
      sourceAttributes: { src: "norea-media://reader-asset/missing.jpg" },
    },
  ]);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ParentProbe activeChapter={chapter2} />
      </QueryClientProvider>,
    );
  });
  expect(current!.remoteMediaError).toBe(false);
  expect(current!.mediaRepairAttention).toBe(false);
});
