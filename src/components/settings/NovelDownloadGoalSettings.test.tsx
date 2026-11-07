import { Button } from "@mantine/core";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  goals: [] as unknown[],
  resume: vi.fn(async (ids: readonly number[]) => ids.length),
  invalidate: vi.fn(async () => undefined),
  show: vi.fn(), operation: Promise.resolve(),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "download-goals" ? mocks.goals : [
      { id: 1, name: "One", isLocal: false }, { id: 2, name: "Two", isLocal: false },
      { id: 3, name: "Local", isLocal: true }, { id: 4, name: "Legacy positive", isLocal: false },
    ], isPending: false, isError: false,
  }),
  useMutation: (options: { mutationFn: (input: readonly number[]) => Promise<number>; onSuccess: (result: number) => void; onSettled: () => void }) => ({
    isPending: false,
    mutate: (input: readonly number[]) => {
      mocks.operation = options.mutationFn(input).then(result => options.onSuccess(result)).finally(options.onSettled);
    },
  }),
}));
vi.mock("../../db/queries/novel", () => ({ listLibraryNovels: vi.fn() }));
vi.mock("../../lib/download-goals/goal-service", () => ({ resumeStoppedDownloadGoals: mocks.resume }));
vi.mock("../DownloadGoalWorkLine", () => ({ DOWNLOAD_GOALS_QUERY_KEY: ["download-goals"] }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.show } }));
import { NovelDownloadGoalSettings } from "./NovelDownloadGoalSettings";
import { ListRow } from "../ui/ListRow";
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode), ...elements(element.props.trailing as ReactNode)];
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.goals = [
    { novelId: 1, goal: { kind: "none" } }, { novelId: 2, goal: { kind: "none" } },
    { novelId: 3, goal: { kind: "none" } }, { novelId: 4, goal: { kind: "entire" } },
  ];
});

it("shows explicit source-work pauses, not obsolete positive per-work policies", () => {
  const tree = elements(NovelDownloadGoalSettings({ isBusy: false }));
  expect(tree.filter(element => element.type === ListRow).map(element => element.props.title)).toEqual(["One", "Two"]);
  expect(tree.some(element => element.props.role === "radiogroup")).toBe(false);
  expect(mocks.resume).not.toHaveBeenCalled();
});

it("resumes all visible paused works only after an explicit action and refreshes their state", async () => {
  const tree = elements(NovelDownloadGoalSettings({ isBusy: false }));
  const all = tree.find(element => element.type === Button && element.props.children === "settings.downloads.pausedWorks.resumeAll")!;
  (all.props.onClick as () => void)();
  await mocks.operation;
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith([1, 2]);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["download-goals"] });
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["download-goal"] });
  expect(mocks.show).toHaveBeenCalledWith({ color: "ok", message: "settings.downloads.pausedWorks.resumed" });
});

it("can resume one paused work without resuming the others", async () => {
  const tree = elements(NovelDownloadGoalSettings({ isBusy: false }));
  const one = tree.find(element => element.type === ListRow && element.props.title === "One")!;
  ((one.props.trailing as ReactElement<{ onClick: () => void }>).props.onClick)();
  await mocks.operation;
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith([1]);
});

it("shows the empty pause state without a per-work policy editor", () => {
  mocks.goals = [{ novelId: 4, goal: { kind: "entire" } }];
  const tree = elements(NovelDownloadGoalSettings({ isBusy: false }));
  expect(tree.some(element => element.props.children === "settings.downloads.pausedWorks.empty")).toBe(true);
  expect(tree.some(element => element.type === Button || element.type === ListRow)).toBe(false);
});
