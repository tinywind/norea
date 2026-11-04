import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateView } from "../components/AppFrame";
import { ReaderContent } from "../components/ReaderContent";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  chapterQuery: {
    data: null,
    error: null as Error | null,
    isLoading: false,
    refetch: vi.fn(),
  },
  queryOptions: [] as { enabled: boolean }[],
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: (options: { enabled: boolean }) => {
    mocks.queryOptions.push(options);
    return mocks.chapterQuery;
  },
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
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
  useReaderPersistence: () => ({ incognitoMode: false, persistProgress: vi.fn() }),
}));
vi.mock("../components/reader/use-reader-settings", () => ({
  useReaderSettings: () => ({
    effectiveReaderGeneral: { fullPageReader: true },
    effectiveReaderAppearance: { backgroundColor: "#ffffff" },
  }),
}));
vi.mock("../components/reader/use-reader-chapter-document", () => ({
  useReaderChapterDocument: () => ({
    activeChapterId: null,
    content: "",
    hasChapterContent: false,
    readerPreparation: { document: null, error: null, isPending: false },
    readerProgressPersistenceReady: false,
  }),
}));
vi.mock("../components/reader/use-reader-chapter-navigation", () => ({
  useReaderChapterNavigation: () => ({
    autoDownloadingChapterId: null,
    awaitingChapterDownload: false,
    chapterUnavailable: null,
    initialProgressOverride: null,
    handleReaderBack: vi.fn(),
    openAdjacent: vi.fn(),
    openChapter: vi.fn(),
  }),
}));

import { ReaderPage } from "./reader";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

beforeEach(() => {
  mocks.chapterQuery.error = null;
  mocks.chapterQuery.isLoading = false;
  mocks.queryOptions = [];
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

async function render(chapterId: number) {
  function Probe() {
    tree = ReaderPage({ chapterId });
    return null;
  }
  harness = mountBackNavigationHarness();
  await harness.render(<Probe />);
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
