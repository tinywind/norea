import { Fragment, useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderContent } from "../components/ReaderContent";
import { prepareReaderDocument } from "../components/reader-document";
import { collectElements, mountBackNavigationHarness, type BackNavigationHarness } from "../lib/android-back-navigation.test-support";
import { chapterDetailQueryKey, chapterListQueryKey, novelDetailQueryKey } from "../lib/reader-query-invalidation";
import { useReaderStore } from "../store/reader";

const mocks = vi.hoisted(() => ({
  chapterId: 1,
  preparedId: 2 as number | null,
  mounted: new Map<string, { instance: object; props: Record<string, unknown> }>(),
  mounts: new Map<string, number>(),
  tree: null as ReactNode,
  persist: vi.fn(),
  bionic: false,
}));
const chapters = [1, 2, 3, 9, 10].map((id, position) => ({
  id, novelId: 7, name: `Chapter ${id}`, position, chapterNumber: String(id), path: `chapter/${id}`,
  progress: 0, isDownloaded: true, contentBytes: 100, contentType: "html",
  content: `<p>Chapter ${id}</p>`, bookmark: false,
}));
const novel = { id: 7, pluginId: "test", sourceNovelId: "novel", name: "Novel", path: "novel" };
const noop = () => {};
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: queryKey[0] === chapterDetailQueryKey(0)[0] && queryKey[1] === "detail" ? chapters.find(chapter => chapter.id === queryKey[2])
      : queryKey[0] === novelDetailQueryKey(0)[0] ? novel
      : queryKey[0] === chapterListQueryKey(0)[0] ? chapters : null,
    error: null, isLoading: false, isSuccess: true, refetch: vi.fn(),
  }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@mantine/hooks", () => ({ useMediaQuery: () => false }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/use-body-flag", () => ({ useBodyFlag: vi.fn() }));
vi.mock("../lib/runtime/system-bars", () => ({ useReaderSystemBarBackground: vi.fn() }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => undefined } }));
vi.mock("../components/reader/ReaderEndOfNovel", () => ({
  ReaderEndOfNovel: () => null, useNovelEndCheck: () => ({ check: { status: "idle" }, run: vi.fn() }),
}));
vi.mock("../components/reader/use-reader-chrome", () => ({ useReaderChrome: () => ({
  readerChromeVisible: false, readerChromeDismissible: false, readerSettingsOpen: false, chapterListOpen: false,
  openReaderSettingsPanel: noop, closeReaderSettingsPanel: noop, openChapterList: noop, closeChapterList: noop,
  closeTopReaderOverlay: noop, handleReaderMenuTap: noop, hideReaderChrome: noop, handleReaderActivity: noop,
  handleFrequentReaderActivity: noop, handleReaderSeekbarActiveChange: noop, chromeFocusHandlers: {},
}) }));
vi.mock("../components/reader/use-next-reader-chapter", () => ({ useNextReaderChapter: (options: {
  active: boolean; currentChapterReady: boolean; nextChapter?: { id: number };
}) => {
  const chapter = chapters.find(item => item.id === mocks.preparedId && item.id === options.nextChapter?.id);
  return options.active && options.currentChapterReady && chapter
    ? { chapter, document: prepareReaderDocument(chapter.content, mocks.bionic) } : null;
} }));
vi.mock("../components/reader/use-reader-keyboard", () => ({ useReaderKeyboard: vi.fn() }));
vi.mock("../components/reader/use-reader-persistence", () => ({
  useReaderPersistence: () => ({ incognitoMode: false, persistProgress: mocks.persist }),
}));
vi.mock("../components/reader/use-reader-settings", () => ({ useReaderSettings: () => ({
  effectiveReaderGeneral: { ...useReaderStore.getState().general, bionicReading: mocks.bionic },
  effectiveReaderAppearance: useReaderStore.getState().appearance,
}) }));
vi.mock("../components/reader/use-reader-chapter-document", () => ({ useReaderChapterDocument: ({ chapterId }: { chapterId: number }) => {
  const chapter = chapters.find(item => item.id === chapterId)!;
  return {
    activeChapterId: chapterId, content: chapter.content, readerContentKey: `${chapterId}:stored`,
    hasChapterContent: true, isPdfChapter: false, readerProgressPersistenceReady: true,
    readerPreparation: { document: prepareReaderDocument(chapter.content, mocks.bionic), isPending: false, error: null },
    handleRemoteMediaError: noop, setRemoteMediaError: noop,
  };
} }));
vi.mock("../components/reader/use-reader-chapter-navigation", () => ({ useReaderChapterNavigation: () => ({
  autoDownloadingChapterId: null, awaitingChapterDownload: false, chapterUnavailable: null,
  initialProgressOverride: { chapterId: mocks.chapterId, progress: 0 }, setInitialProgressOverride: noop,
  handleReaderBack: noop, openAdjacent: noop, openChapter: noop,
}) }));
vi.mock("../components/ReaderContent", () => ({ ReaderContent: (props: Record<string, unknown>) => {
  const key = String(props.contentKey);
  const instance = useRef({});
  mocks.mounted.set(key, { instance: instance.current, props });
  useImperativeHandle(props.ref as Ref<unknown>, () => ({ completeIfAtEnd: vi.fn() }));
  useEffect(() => {
    mocks.mounts.set(key, (mocks.mounts.get(key) ?? 0) + 1);
    return () => { mocks.mounted.delete(key); };
  }, [key]);
  return null;
} }));

import { ReaderPage } from "./reader";
let harness: BackNavigationHarness;
function Probe() {
  mocks.tree = ReaderPage({ chapterId: mocks.chapterId });
  // Mount both actual reader slots under one parent, as the route does, without a browser DOM.
  const frame = collectElements(mocks.tree).find(element => element.props.className === "norea-reader-content-frame")!;
  return <Fragment>{frame.props.children as ReactNode}</Fragment>;
}
beforeEach(() => {
  mocks.chapterId = 1; mocks.preparedId = 2; mocks.bionic = false;
  mocks.mounted.clear(); mocks.mounts.clear(); mocks.persist.mockClear();
  harness = mountBackNavigationHarness();
});
afterEach(async () => { await harness.unmount(); vi.clearAllMocks(); });

it("promotes the same prepared ReaderContent instance instead of mounting a new page", async () => {
  await harness.render(<Probe />);
  const prepared = mocks.mounted.get("2:stored")!;
  expect(prepared.props.preparing).toBe(true);
  expect(prepared.props.ref).toBeUndefined();
  expect(prepared.props.onProgressChange).toBeUndefined();
  expect(prepared.props.onPageIndexChange).toBeUndefined();
  expect(prepared.props.onBoundaryPage).toBeUndefined();
  expect(mocks.mounted.size).toBe(2);
  mocks.chapterId = 2; mocks.preparedId = 3;
  await harness.render(<Probe />);
  expect(mocks.mounted.get("2:stored")!.instance).toBe(prepared.instance);
  expect(mocks.mounts.get("2:stored")).toBe(1);
  expect(mocks.mounted.get("2:stored")!.props.preparing).toBeUndefined();
  expect(mocks.mounted.get("2:stored")!.props.onProgressChange).toBeTypeOf("function");
  expect([...mocks.mounted.keys()]).toEqual(["2:stored", "3:stored"]);
  expect(collectElements(mocks.tree).filter(element => element.type === ReaderContent)).toHaveLength(2);
  expect(mocks.persist).not.toHaveBeenCalled();
});

it("keeps the current instance while replacement preparation is pending and drops old work on jumps or close", async () => {
  await harness.render(<Probe />);
  const current = mocks.mounted.get("1:stored")!.instance;
  mocks.bionic = true; mocks.preparedId = null;
  await harness.render(<Probe />);
  expect(mocks.mounted.get("1:stored")!.instance).toBe(current);
  expect([...mocks.mounted.keys()]).toEqual(["1:stored"]);
  mocks.chapterId = 9; mocks.preparedId = 10;
  await harness.render(<Probe />);
  expect([...mocks.mounted.keys()]).toEqual(["9:stored", "10:stored"]);
  await harness.render(<Probe />, { active: false });
  expect([...mocks.mounted.keys()]).toEqual(["9:stored"]);
  expect(mocks.persist).not.toHaveBeenCalled();
});
