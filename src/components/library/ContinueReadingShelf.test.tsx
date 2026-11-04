import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContinueReadingEntry } from "../../db/queries/continue-reading";

const mocks = vi.hoisted(() => ({
  data: [] as ContinueReadingEntry[],
  enabled: [] as boolean[],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled: boolean }) => {
    mocks.enabled.push(options.enabled);
    return { data: mocks.data };
  },
}));
vi.mock("../../db/queries/continue-reading", async (original) => ({
  ...(await original<typeof import("../../db/queries/continue-reading")>()),
  listContinueReading: vi.fn(),
}));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) =>
      Object.keys(values).length ? `${key}:${Object.values(values).join(",")}` : key,
  }),
}));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => null } }));
vi.mock("../../lib/use-novel-cover-source", () => ({ useNovelCoverSource: () => null }));

import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import { useLibraryStore } from "../../store/library";
import { ContinueReadingShelf, isContinueReadingShelfVisible } from "./ContinueReadingShelf";

const reading: ContinueReadingEntry = {
  chapterId: 11, chapterNumber: null, nextChapterId: null, nextChapterNumber: null, nextChapterPosition: null, novelCover: null, novelId: 1,
  novelIsLocal: false, novelName: "Reading", novelPath: "/1", pluginId: "s", position: 2,
  progress: 40, readAt: 2,
};
const finished: ContinueReadingEntry = {
  ...reading, chapterId: 20, nextChapterId: 21, nextChapterPosition: 8, novelId: 2,
  novelName: "Finished", position: 7, progress: 100, readAt: 1,
};

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

async function render(onOpen = vi.fn()) {
  function Probe() {
    tree = ContinueReadingShelf({ active: true, onOpen });
    return null;
  }
  harness ??= mountBackNavigationHarness();
  await harness.render(<Probe />);
  return collectElements(tree);
}

async function renderCard(card: ReactElement<Record<string, unknown>>) {
  let cardTree: ReactNode;
  function Probe() {
    cardTree = (card.type as (props: unknown) => ReactNode)(card.props);
    return null;
  }
  harness ??= mountBackNavigationHarness();
  await harness.render(<Probe />);
  return collectElements(cardTree);
}

beforeEach(() => {
  mocks.data = [reading, finished];
  mocks.enabled = [];
  useLibraryStore.setState({ continueReadingCollapsed: false });
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

it("renders nothing until a novel can be continued", async () => {
  mocks.data = [];
  await render();
  expect(tree).toBeNull();
});

it("shows one card per novel in query order", async () => {
  const elements = await render();
  const cards = elements.filter((element) => element.props.entry);
  expect(cards.map((card) => (card.props.entry as ContinueReadingEntry).novelId)).toEqual([1, 2]);
});

it("resumes an unfinished chapter with a progress ring and opens the next chapter of a finished one", async () => {
  const onOpen = vi.fn();
  const cards = (await render(onOpen)).filter((element) => element.props.entry);

  const resume = await renderCard(cards[0]!);
  expect(resume.some((element) => element.props.sections)).toBe(true);
  expect(resume.some((element) => element.props.children === "history.chapterNumber:2")).toBe(true);
  (resume[0]!.props.onClick as () => void)();
  expect(onOpen).toHaveBeenLastCalledWith(11);

  const next = await renderCard(cards[1]!);
  expect(next.some((element) => element.props.sections)).toBe(false);
  expect(next.some((element) => element.props.children === "library.continueReading.next")).toBe(true);
  expect(next.some((element) => element.props.children === "history.chapterNumber:8")).toBe(true);
  (next[0]!.props.onClick as () => void)();
  expect(onOpen).toHaveBeenLastCalledWith(21);
});

it("labels a card with the chapter's number, not its list position", async () => {
  mocks.data = [{ ...reading, chapterNumber: "0", position: 1 }, { ...finished, nextChapterNumber: "7.5" }];
  const cards = (await render()).filter((element) => element.props.entry);

  expect((await renderCard(cards[0]!)).some((element) => element.props.children === "history.chapterNumber:0")).toBe(true);
  expect((await renderCard(cards[1]!)).some((element) => element.props.children === "history.chapterNumber:7.5")).toBe(true);
});

it("collapses and expands from its heading and remembers the choice", async () => {
  let elements = await render();
  const toggle = () => elements.find((element) => "aria-expanded" in element.props)!;
  expect(toggle().props["aria-expanded"]).toBe(true);
  await harness!.run(() => (toggle().props.onClick as () => void)());
  expect(useLibraryStore.getState().continueReadingCollapsed).toBe(true);

  elements = await render();
  expect(toggle().props["aria-expanded"]).toBe(false);
  expect(elements.filter((element) => element.props.entry)).toHaveLength(0);
});

it("shows only on the unfiltered All view with the display switch on", () => {
  const allView = {
    enabled: true, filterActive: false, search: "", selectedCategoryId: null, selectionMode: false,
  };
  expect(isContinueReadingShelfVisible(allView)).toBe(true);
  expect(isContinueReadingShelfVisible({ ...allView, enabled: false })).toBe(false);
  expect(isContinueReadingShelfVisible({ ...allView, selectedCategoryId: 3 })).toBe(false);
  expect(isContinueReadingShelfVisible({ ...allView, search: "dra" })).toBe(false);
  expect(isContinueReadingShelfVisible({ ...allView, filterActive: true })).toBe(false);
  expect(isContinueReadingShelfVisible({ ...allView, selectionMode: true })).toBe(false);
});
