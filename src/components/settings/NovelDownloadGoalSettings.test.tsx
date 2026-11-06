import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selected: ["1", "2", "3"],
  goals: [] as unknown[],
  setGoal: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
  operation: Promise.resolve(),
  getNovel: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: () => [mocks.selected, vi.fn()],
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "download-goals" ? mocks.goals : [
      { id: 1, name: "One", isLocal: false }, { id: 2, name: "Two", isLocal: false }, { id: 3, name: "Local", isLocal: true },
    ],
    isPending: false, isError: false,
  }),
  useMutation: (options: { mutationFn: (input: never) => Promise<never>; onSuccess: (result: never) => void; onSettled: () => void }) => ({
    isPending: false,
    mutate: (input: never) => {
      mocks.operation = options.mutationFn(input).then(result => options.onSuccess(result)).finally(options.onSettled);
    },
  }),
}));
vi.mock("../../db/queries/novel", () => ({ listLibraryNovels: vi.fn(), getNovelById: mocks.getNovel }));
vi.mock("../../lib/download-goals/goal-service", () => ({ setDownloadGoal: mocks.setGoal }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
import { MultiSelect } from "@mantine/core";
import { DownloadGoalChoices } from "../DownloadGoalChoices";
import { NovelDownloadGoalSettings } from "./NovelDownloadGoalSettings";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.goals = [];
  mocks.selected = ["1", "2", "3"];
  mocks.getNovel.mockImplementation(async (id: number) => ({ id, isLocal: id === 3 }));
});

it("changes the selected source novels through the existing persistent goal service", async () => {
  const tree = elements(NovelDownloadGoalSettings({ isBusy: false }));
  const picker = tree.find(element => element.type === MultiSelect)!;
  expect(picker.props.data).toEqual([{ value: "1", label: "One" }, { value: "2", label: "Two" }]);
  const choices = tree.find(element => element.type === DownloadGoalChoices)!;
  (choices.props.onChoose as (goal: unknown) => void)({ kind: "entire" });
  await mocks.operation;
  expect(mocks.setGoal.mock.calls).toEqual([[1, { kind: "entire" }], [2, { kind: "entire" }]]);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["download-goals"] });
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["download-goal"] });
});

it("does not restart automatic downloads when their existing shared goal is chosen", () => {
  mocks.goals = [{ novelId: 1, goal: { kind: "entire" } }, { novelId: 2, goal: { kind: "entire" } }];
  const choices = elements(NovelDownloadGoalSettings({ isBusy: false })).find(element => element.type === DownloadGoalChoices)!;
  expect(choices.props.current).toEqual({ kind: "entire" });
  (choices.props.onChoose as (goal: unknown) => void)({ kind: "entire" });
  expect(mocks.setGoal).not.toHaveBeenCalled();
});
