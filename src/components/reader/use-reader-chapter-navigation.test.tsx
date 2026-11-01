import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { enqueueChapterDownload } from "../../lib/tasks/chapter-download";
import { useReaderChapterNavigation } from "./use-reader-chapter-navigation";
import { useNextReaderChapter } from "./use-next-reader-chapter";
import { useReaderDocument } from "../use-reader-document";

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), t: (key: string) => key }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
  useRouterState: () => "/reader?chapterId=11",
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: navigation.t }) }));
vi.mock("../../lib/page-activity", () => ({ usePageActivity: () => false }));
vi.mock("../../lib/android-back-navigation", () => ({ usePageBackNavigation: vi.fn() }));
vi.mock("../../db/queries/novel", () => ({
  getNovelById: vi.fn(async () => ({ id: 7, pluginId: "source", name: "Work", path: "/work" })),
}));
vi.mock("../use-reader-document", () => ({ useReaderDocument: vi.fn() }));
vi.mock("../../lib/tasks/chapter-download", () => ({
  subscribeChapterDownloads: vi.fn(() => () => {}),
  enqueueChapterDownload: vi.fn(() => ({ id: "download", promise: new Promise<void>(() => {}) })),
}));

let root: Root | undefined;
let queryClient: QueryClient;
let current: ReturnType<typeof useReaderChapterNavigation>;
type NavigationChapter = NonNullable<Parameters<typeof useReaderChapterNavigation>[0]["chapter"]>;
const chapter = {
  id: 11, novelId: 7, position: 1, name: "Chapter", path: "/chapter/1",
  chapterNumber: "1", contentType: "html", isDownloaded: false, contentBytes: 80,
  page: "1", bookmark: false, unread: true, progress: 0, sourceContentType: "html",
  mediaBytes: 5, mediaRepairNeeded: true, releaseTime: null, readAt: null,
  createdAt: null, foundAt: 1, updatedAt: 1,
} as const;

function mount() {
  const document = {
    nodeType: 9, activeElement: null, body: null as unknown,
    documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {},
  };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  root = createRoot(container as unknown as Element);
}

function Probe({ storedChapter, nextChapter }: { storedChapter: NavigationChapter; nextChapter?: NavigationChapter }) {
  current = useReaderChapterNavigation({
    chapterId: storedChapter.id, chapter: storedChapter, previousChapter: undefined, nextChapter,
    readerProgressPersistenceReady: true, contentRef: { current: null }, openedChapterRef: { current: storedChapter.id },
  });
  return null;
}

async function render(storedChapter: NavigationChapter, nextChapter?: NavigationChapter) {
  await act(async () => root!.render(
    <QueryClientProvider client={queryClient}><Probe storedChapter={storedChapter} nextChapter={nextChapter} /></QueryClientProvider>,
  ));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  queryClient?.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("opens a stored incomplete chapter offline without automatically downloading it after refresh", async () => {
  mount();
  await render(chapter);
  await render({ ...chapter });
  await act(async () => current.openChapter(chapter));
  expect(enqueueChapterDownload).not.toHaveBeenCalled();
  expect(current.autoDownloadingChapterId).toBeNull();
});

it("navigates to an adjacent stored incomplete body without scheduling a download", async () => {
  mount();
  const nextChapter = { ...chapter, id: 12, position: 2, chapterNumber: "2", path: "/chapter/2" };
  await render({ ...chapter, isDownloaded: true }, nextChapter);
  await act(async () => current.openAdjacent(1));
  expect(navigation.navigate).toHaveBeenCalledWith({ to: "/reader", search: { chapterId: 12 }, replace: true });
  expect(enqueueChapterDownload).not.toHaveBeenCalled();
});

it("prepares a stored incomplete next chapter document without requesting source content", async () => {
  mount();
  const nextChapter = { ...chapter, id: 12, content: "<p>Stored next chapter</p>" };
  queryClient.setQueryData(["chapter", "detail", 12], nextChapter);
  function NextProbe() {
    useNextReaderChapter({
      nextChapter,
      currentNovel: { id: 7, pluginId: "source", name: "Work", path: "/work" },
      currentNovelId: 7, currentSourceName: null, autoDownloadNextChapter: true,
      bionicReading: false, currentChapterReady: true,
    });
    return null;
  }
  await act(async () => root!.render(<QueryClientProvider client={queryClient}><NextProbe /></QueryClientProvider>));
  expect(useReaderDocument).toHaveBeenCalledWith("<p>Stored next chapter</p>", false, 12);
  expect(enqueueChapterDownload).not.toHaveBeenCalled();
});

it("still schedules an interactive download when the chapter body is missing", async () => {
  mount();
  await render({ ...chapter, contentBytes: 0 });
  expect(enqueueChapterDownload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 11, priority: "interactive" }));
  expect(current.autoDownloadingChapterId).toBe(11);
});
