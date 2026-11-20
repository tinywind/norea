import { useImperativeHandle, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateView } from "../components/AppFrame";
import { ReaderContent } from "../components/ReaderContent";
import { ReaderEndOfNovel } from "../components/reader/ReaderEndOfNovel";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../lib/android-back-navigation.test-support";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
  novelDetailQueryKey,
} from "../lib/reader-query-invalidation";
import { useReaderStore } from "../store/reader";

const mocks = vi.hoisted(() => ({
  chapterQuery: {
    data: null as Record<string, unknown> | null,
    error: null as Error | null,
    isLoading: false,
    isSuccess: true,
    refetch: vi.fn(),
  },
  chapterListQuery: {
    data: [] as Record<string, unknown>[],
    error: null as Error | null,
    isLoading: false,
    isSuccess: true,
    refetch: vi.fn(),
  },
  novelQuery: {
    data: null as Record<string, unknown> | null,
    error: null as Error | null,
    isLoading: false,
    isSuccess: true,
    refetch: vi.fn(),
  },
  docState: {
    activeChapterId: null as number | null,
    content: "",
    hasChapterContent: false,
    isPdfChapter: false,
    readerContentKey: "0:partial",
    readerPreparation: { document: null as unknown, error: null, isPending: false },
    readerProgressPersistenceReady: false,
  },
  initialProgressOverride: null as { chapterId: number; progress: number; allowProgressReset?: boolean } | null,
  persistProgress: vi.fn(),
  completeIfAtEnd: vi.fn(() => true),
  scrollToStart: vi.fn(),
  handleReaderBack: vi.fn(),
  handleBackToNovel: vi.fn(),
  openAdjacent: vi.fn(),
  openChapter: vi.fn(),
  setInitialProgressOverride: vi.fn(),
  onBeforeBack: undefined as (() => void) | undefined,
  queryOptions: [] as { enabled: boolean; queryKey?: unknown[] }[],
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: (options: { enabled: boolean; queryKey?: unknown[] }) => {
    mocks.queryOptions.push(options);
    if (options.queryKey?.[0] === chapterDetailQueryKey(0)[0] && options.queryKey?.[1] === "detail") {
      return mocks.chapterQuery;
    }
    if (options.queryKey?.[0] === chapterListQueryKey(0)[0] && options.queryKey?.[1] === "list") {
      return mocks.chapterListQuery;
    }
    if (options.queryKey?.[0] === novelDetailQueryKey(0)[0]) {
      return mocks.novelQuery;
    }
    return mocks.chapterQuery;
  },
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("@mantine/hooks", () => ({ useMediaQuery: () => false }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/use-body-flag", () => ({ useBodyFlag: vi.fn() }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => undefined } }));
vi.mock("../components/reader/reader-chrome-theme", () => ({
  getReaderChromeThemeStyle: () => ({}),
}));
vi.mock("../components/reader/ReaderEndOfNovel", () => ({
  ReaderEndOfNovel: () => null,
  useNovelEndCheck: () => ({ check: { status: "idle" }, run: vi.fn() }),
}));
vi.mock("../components/reader/use-next-reader-chapter", () => ({ useNextReaderChapter: vi.fn() }));
vi.mock("../components/reader/use-reader-keyboard", () => ({ useReaderKeyboard: vi.fn() }));
vi.mock("../components/reader/use-reader-persistence", () => ({
  useReaderPersistence: () => ({ incognitoMode: false, persistProgress: mocks.persistProgress }),
}));
vi.mock("../components/reader/use-reader-settings", () => ({
  useReaderSettings: () => ({
    effectiveReaderGeneral: { fullPageReader: true },
    effectiveReaderAppearance: { backgroundColor: "#ffffff", customJs: "" },
  }),
}));
vi.mock("../components/reader/use-reader-chapter-document", () => ({
  useReaderChapterDocument: () => mocks.docState,
}));
vi.mock("../components/reader/use-reader-chapter-navigation", () => ({
  useReaderChapterNavigation: (options: { onBeforeBack?: () => void }) => {
    mocks.onBeforeBack = options.onBeforeBack;
    return {
      autoDownloadingChapterId: null,
      awaitingChapterDownload: false,
      chapterUnavailable: null,
      initialProgressOverride: mocks.initialProgressOverride,
      setInitialProgressOverride: mocks.setInitialProgressOverride,
      handleReaderBack: mocks.handleReaderBack,
      handleBackToNovel: mocks.handleBackToNovel,
      openAdjacent: mocks.openAdjacent,
      openChapter: mocks.openChapter,
    };
  },
}));
vi.mock("../components/ReaderContent", () => ({
  ReaderContent: (props: Record<string, unknown>) => {
    useImperativeHandle(props.ref as Ref<unknown>, () => ({
      completeIfAtEnd: mocks.completeIfAtEnd,
      patchMediaElements: vi.fn(),
      scrollByPage: vi.fn(),
      scrollToStart: mocks.scrollToStart,
    }));
    return null;
  },
}));

import { ReaderPage } from "./reader";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

beforeEach(() => {
  mocks.chapterQuery.data = null;
  mocks.chapterQuery.error = null;
  mocks.chapterQuery.isLoading = false;
  mocks.chapterQuery.isSuccess = true;
  mocks.chapterListQuery.data = [];
  mocks.chapterListQuery.isSuccess = true;
  mocks.novelQuery.data = null;
  mocks.docState = {
    activeChapterId: null,
    content: "",
    hasChapterContent: false,
    isPdfChapter: false,
    readerContentKey: "0:partial",
    readerPreparation: { document: null, error: null, isPending: false },
    readerProgressPersistenceReady: false,
  };
  mocks.completeIfAtEnd.mockReset().mockReturnValue(true);
  mocks.scrollToStart.mockReset();
  mocks.persistProgress.mockReset();
  mocks.handleReaderBack.mockReset();
  mocks.handleBackToNovel.mockReset();
  mocks.openAdjacent.mockReset();
  mocks.setInitialProgressOverride.mockReset();
  mocks.onBeforeBack = undefined;
  mocks.queryOptions = [];
  mocks.initialProgressOverride = null;
  useReaderStore.getState().resetReadingProgress();
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

function Probe({
  chapterId,
  fromStart,
}: {
  chapterId: number;
  fromStart?: boolean;
}) {
  tree = ReaderPage({ chapterId, fromStart });
  const content = collectElements(tree).find(
    (element) => element.type === ReaderContent,
  );
  return content ?? null;
}

async function render(
  chapterId: number,
  options: { fromStart?: boolean; active?: boolean } = {},
) {
  harness ??= mountBackNavigationHarness();
  await harness.render(
    <Probe chapterId={chapterId} fromStart={options.fromStart} />,
    { active: options.active ?? true },
  );
  return collectElements(tree);
}

it.each([0, -1])("keeps the reader back control visible for invalid chapter ID %i", async (chapterId) => {
  const elements = await render(chapterId);
  expect(elements.find((element) => element.type === StateView)?.props.title).toBe("reader.chapterNotFound");
  expect(elements.some((element) => element.type === ReaderContent)).toBe(false);
  expect(mocks.queryOptions[0]?.enabled).toBe(false);
  expect(elements.find((element) => element.props.className === "norea-reader-shell")?.props["data-chrome-visible"])
    .toBe(true);
});

it("shows a missing stored chapter with a retry action instead of reader content", async () => {
  const elements = await render(42);
  const state = elements.find((element) => element.type === StateView)!;
  expect(state.props.title).toBe("reader.chapterNotFound");
  expect(elements.some((element) => element.type === ReaderContent)).toBe(false);
  (state.props.action as { onClick: () => void }).onClick();
  expect(mocks.chapterQuery.refetch).toHaveBeenCalledOnce();
});

it("forces completion at forward boundary on the last chapter and routes Back to novel cleanly", async () => {
  const lastChapter = {
    id: 10, novelId: 7, name: "Ch 10", position: 10, chapterNumber: "10",
    progress: 0, isDownloaded: true, contentBytes: 100, contentType: "html",
    content: "<p>End</p>", bookmark: false,
  };
  mocks.chapterQuery.data = lastChapter;
  mocks.chapterListQuery.data = [lastChapter];
  mocks.novelQuery.data = { id: 7, name: "Novel", isLocal: false, pluginId: "src" };
  mocks.docState = {
    activeChapterId: 10, content: "<p>End</p>", hasChapterContent: true, isPdfChapter: false,
    readerContentKey: "10:stored",
    readerPreparation: { document: null, error: null, isPending: false },
    readerProgressPersistenceReady: true,
  };
  mocks.completeIfAtEnd.mockReturnValue(false);

  const elements = await render(10);
  const content = elements.find((element) => element.type === ReaderContent)!;
  await harness!.run(() => {
    (content.props.onBoundaryPage as (dir: 1 | -1) => void)(1);
  });

  expect(mocks.completeIfAtEnd).toHaveBeenCalledWith({ force: true });
  expect(mocks.persistProgress).toHaveBeenCalledWith({ chapterId: 10, novelId: 7, progress: 100 });
  expect(mocks.openAdjacent).toHaveBeenCalledWith(1, { skipComplete: true });

  const afterBoundary = collectElements(tree);
  const endCard = afterBoundary.find((element) => element.type === ReaderEndOfNovel);
  expect(endCard).toBeDefined();
  (endCard!.props.onBackToNovel as () => void)();
  expect(mocks.handleBackToNovel).toHaveBeenCalledWith(7);
});

it("opens a chapter from 0% with fromStart, clears stale anchor/progress, and resets on reactivation", async () => {
  const nextChapter = {
    id: 11, novelId: 7, name: "Ch 11", position: 11, chapterNumber: "11",
    progress: 45, isDownloaded: true, contentBytes: 100, contentType: "html",
    content: "<p>Next</p>", bookmark: false,
  };
  useReaderStore.getState().setChapterScrollAnchor(11, {
    novelId: 7, segmentIndex: 3, mediaOrdinal: 0, offset: 0.5, segmentCount: 5, progress: 45,
  });
  mocks.chapterQuery.data = nextChapter;
  mocks.chapterListQuery.data = [nextChapter];
  mocks.novelQuery.data = { id: 7, name: "Novel", isLocal: false, pluginId: "src" };
  mocks.docState = {
    activeChapterId: 11, content: "<p>Next</p>", hasChapterContent: true, isPdfChapter: false,
    readerContentKey: "11:stored",
    readerPreparation: { document: null, error: null, isPending: false },
    readerProgressPersistenceReady: true,
  };

  const elements = await render(11, { fromStart: true });
  const content = elements.find((element) => element.type === ReaderContent)!;
  expect(content.props.initialProgress).toBe(0);
  expect(content.props.initialScrollAnchor).toBeNull();
  expect(useReaderStore.getState().chapterScrollAnchors[11]).toBeUndefined();
  expect(mocks.persistProgress).toHaveBeenCalledWith({ chapterId: 11, novelId: 7, progress: 0 });

  await render(11, { fromStart: true, active: false });
  await render(11, { fromStart: true, active: true });
  expect(mocks.scrollToStart).toHaveBeenCalledOnce();
});

it("resets a re-read finished chapter only once real positive movement occurs and keeps 0% reads non-destructive", async () => {
  const finishedChapter = {
    id: 42,
    novelId: 7,
    name: "Chapter 2",
    path: "/ch/2",
    chapterNumber: "2",
    position: 2,
    progress: 100,
    bookmark: false,
    contentType: "html",
    content: "<p>Body</p>",
    isDownloaded: true,
    mediaRepairNeeded: false,
  };
  mocks.chapterQuery.data = finishedChapter;
  mocks.chapterListQuery.data = [finishedChapter];
  mocks.novelQuery.data = { id: 7, name: "Novel", isLocal: false, pluginId: "src" };
  mocks.initialProgressOverride = { chapterId: 42, progress: 0, allowProgressReset: true };
  mocks.docState = {
    activeChapterId: 42,
    content: "<p>Body</p>",
    hasChapterContent: true,
    isPdfChapter: false,
    readerContentKey: "42:stored",
    readerPreparation: { document: { html: "<p>Body</p>" }, error: null, isPending: false },
    readerProgressPersistenceReady: true,
  };

  const elements = await render(42, { fromStart: true });
  const content = elements.find((element) => element.type === ReaderContent)!;
  const onProgressChange = content.props.onProgressChange as (nextProgress: number) => void;

  // Simply opening a 100% chapter with fromStart must NOT reset it to 0%.
  expect(mocks.persistProgress).not.toHaveBeenCalled();

  // Reporting 0% without real movement must NOT consume or trigger allowProgressReset.
  onProgressChange(0);
  expect(mocks.persistProgress).toHaveBeenLastCalledWith({
    chapterId: 42,
    novelId: 7,
    progress: 0,
  });

  // First positive scroll/page turn resets progress once.
  onProgressChange(18);
  expect(mocks.persistProgress).toHaveBeenLastCalledWith({
    chapterId: 42,
    novelId: 7,
    progress: 18,
    allowProgressReset: true,
  });

  // Subsequent movement in the same session no longer requests allowProgressReset.
  onProgressChange(45);
  expect(mocks.persistProgress).toHaveBeenLastCalledWith({
    chapterId: 42,
    novelId: 7,
    progress: 45,
  });
});

it("keeps an in-reader next-chapter transition non-destructive on mount for partially-read and finished chapters", async () => {
  const partialChapter = {
    id: 43,
    novelId: 7,
    name: "Chapter 3",
    path: "/ch/3",
    chapterNumber: "3",
    position: 3,
    progress: 45,
    bookmark: false,
    contentType: "html",
    content: "<p>Partial</p>",
    isDownloaded: true,
    mediaRepairNeeded: false,
  };
  useReaderStore.getState().setChapterScrollAnchor(43, {
    novelId: 7, segmentIndex: 2, mediaOrdinal: 0, offset: 0.4, segmentCount: 5, progress: 45,
  });
  mocks.chapterQuery.data = partialChapter;
  mocks.chapterListQuery.data = [partialChapter];
  mocks.novelQuery.data = { id: 7, name: "Novel", isLocal: false, pluginId: "src" };
  mocks.initialProgressOverride = { chapterId: 43, progress: 0, allowProgressReset: true };
  mocks.docState = {
    activeChapterId: 43,
    content: "<p>Partial</p>",
    hasChapterContent: true,
    isPdfChapter: false,
    readerContentKey: "43:stored",
    readerPreparation: { document: { html: "<p>Partial</p>" }, error: null, isPending: false },
    readerProgressPersistenceReady: true,
  };

  // Navigating forward inside the reader uses initialProgressOverride (fromStart=false),
  // so the chapter renders from 0% without immediately erasing saved progress or anchor on mount.
  const elements = await render(43);
  const content = elements.find((element) => element.type === ReaderContent)!;
  expect(content.props.initialProgress).toBe(0);
  expect(content.props.initialScrollAnchor).toBeNull();
  expect(useReaderStore.getState().chapterScrollAnchors[43]).toBeDefined();
  expect(mocks.persistProgress).not.toHaveBeenCalled();

  const onProgressChange = content.props.onProgressChange as (nextProgress: number) => void;
  onProgressChange(12);
  expect(mocks.persistProgress).toHaveBeenLastCalledWith({
    chapterId: 43,
    novelId: 7,
    progress: 12,
    allowProgressReset: true,
  });
});
