import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RecentlyReadEntry } from "../db/queries/chapter";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  clearMutate: vi.fn(),
  confirm: vi.fn<(options: { danger?: boolean; title: string }) => Promise<boolean>>(),
  entries: [] as RecentlyReadEntry[],
  getAdjacentChapter: vi.fn(),
  navigate: vi.fn(),
  removeMutate: vi.fn(),
}));

vi.mock("../db/queries/chapter", () => ({
  clearNovelHistory: vi.fn(),
  getAdjacentChapter: mocks.getAdjacentChapter,
  listRecentlyRead: vi.fn(),
}));
vi.mock("@tanstack/react-query", async () => {
  const chapter = await import("../db/queries/chapter");
  return {
    useMutation: (options: { mutationFn: unknown }) => ({
      isPending: false,
      mutate: options.mutationFn === chapter.clearNovelHistory ? mocks.removeMutate : mocks.clearMutate,
    }),
    useQuery: () => ({ data: mocks.entries, error: null, isLoading: false }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../components/ui/ConfirmDialog", () => ({ useConfirm: () => mocks.confirm }));

import { HistoryPage } from "./history";

const entry: RecentlyReadEntry = {
  chapterId: 52,
  chapterName: "Chapter 52",
  novelCover: null,
  novelId: 4,
  novelInLibrary: true,
  novelIsLocal: false,
  novelName: "Novel Title",
  novelPath: "/n/4",
  pluginId: "source",
  position: 52,
  progress: 45,
  readAt: Date.now() / 1000,
};

let harness: BackNavigationHarness | undefined;
let tree: ReturnType<typeof HistoryPage> | undefined;

beforeEach(() => {
  mocks.entries = [entry, { ...entry, chapterId: 9, novelId: 5, novelName: "Done", progress: 100 }];
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

async function mountPage() {
  function Probe() {
    tree = HistoryPage();
    return null;
  }
  harness = mountBackNavigationHarness();
  await harness.render(<Probe />);
  const elements = collectElements(tree);
  return {
    appBarMenu: elements.find((element) => Array.isArray(element.props.items))!.props.items as {
      disabled?: boolean;
      label: string;
      onClick: () => void;
    }[],
    rows: elements.filter((element) => typeof element.props.onContinue === "function"),
  };
}

it("asks before removing one novel and removes it only when confirmed", async () => {
  const { rows } = await mountPage();
  mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await harness!.run(() => (rows[0]!.props.onRemove as () => void)());
  expect(mocks.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true }));
  expect(mocks.removeMutate).not.toHaveBeenCalled();
  await harness!.run(() => (rows[0]!.props.onRemove as () => void)());
  expect(mocks.removeMutate).toHaveBeenCalledWith(4);
});

it("offers Clear all history in the app bar overflow behind a danger confirmation", async () => {
  const { appBarMenu } = await mountPage();
  expect(appBarMenu.map((item) => item.label)).toEqual(["history.clearAll.action"]);
  mocks.confirm.mockResolvedValueOnce(true);
  await harness!.run(() => appBarMenu[0]!.onClick());
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ danger: true, title: "history.clearAll.title" }),
  );
  expect(mocks.clearMutate).toHaveBeenCalledOnce();
});

it("disables Clear all history when there is nothing to clear", async () => {
  mocks.entries = [];
  const { appBarMenu } = await mountPage();
  expect(appBarMenu[0]!.disabled).toBe(true);
});

it("resumes an unfinished chapter and opens the known next chapter of a finished one", async () => {
  const { rows } = await mountPage();
  const continueRow = (index: number, next: unknown) =>
    (rows[index]!.props.onContinue as (next: unknown) => void)(next);

  continueRow(0, undefined);
  expect(mocks.navigate).toHaveBeenLastCalledWith({ search: { chapterId: 52 }, to: "/reader" });
  continueRow(1, { id: 10 });
  expect(mocks.navigate).toHaveBeenLastCalledWith({ search: { chapterId: 10 }, to: "/reader" });
  continueRow(1, null);
  expect(mocks.navigate).toHaveBeenLastCalledWith({ search: { chapterId: 9 }, to: "/reader" });
  expect(mocks.getAdjacentChapter).not.toHaveBeenCalled();
});

it("looks the next chapter up when a finished row is tapped before it loaded", async () => {
  mocks.getAdjacentChapter.mockResolvedValueOnce({ id: 11 });
  const { rows } = await mountPage();
  await harness!.run(() => (rows[1]!.props.onContinue as (next: unknown) => void)(undefined));
  expect(mocks.getAdjacentChapter).toHaveBeenCalledWith(5, 52, 1);
  expect(mocks.navigate).toHaveBeenLastCalledWith({ search: { chapterId: 11 }, to: "/reader" });
});
