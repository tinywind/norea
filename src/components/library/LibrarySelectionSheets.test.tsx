import type { ReactElement, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryCategory } from "../../db/queries/category";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.data, isError: false, isFetching: false, isLoading: false }),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../DownloadGoalChoices", () => ({
  DownloadGoalChoices: () => null,
  DownloadGoalSection: () => null,
  sameDownloadGoal: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
}));
vi.mock("../ui/ResponsiveSheet", () => ({ ResponsiveSheet: () => null }));

import { DownloadGoalSection } from "../DownloadGoalChoices";
import {
  LibraryCategorySheet,
  LibraryDownloadGoalSheet,
  nextCategoryMembership,
  sharedDownloadGoal,
} from "./LibrarySelectionSheets";

let harness: BackNavigationHarness | undefined;
let tree: ReactElement<Record<string, unknown>>;

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

const elements = () => [
  ...collectElements(tree.props.children as ReactNode),
  ...collectElements(tree.props.footer as ReactNode),
];

it("cycles a partly assigned category through some, all and none, and others only between all and none", () => {
  expect(nextCategoryMembership("some", "some")).toBe("all");
  expect(nextCategoryMembership("some", "all")).toBe("none");
  expect(nextCategoryMembership("some", "none")).toBe("some");
  expect(nextCategoryMembership("all", "all")).toBe("none");
  expect(nextCategoryMembership("all", "none")).toBe("all");
  expect(nextCategoryMembership("none", "none")).toBe("all");
});

const categories = [
  { id: 4, name: "Reading" },
  { id: 5, name: "Done" },
  { id: 6, name: "Later" },
] as LibraryCategory[];
const onApply = vi.fn();

function CategoryProbe() {
  tree = LibraryCategorySheet({
    applying: false, categories, novelIds: [1, 2, 3], onApply, onClose: vi.fn(),
    onCreateCategory: vi.fn(), opened: true,
  }) as ReactElement<Record<string, unknown>>;
  return null;
}

it("shows all, some or none per category and applies only the explicit changes", async () => {
  mocks.data = new Map([[4, 3], [5, 1]]);
  harness = mountBackNavigationHarness();
  await harness.render(<CategoryProbe />);
  const box = (label: string) => elements().find((element) => element.props.label === label)!;
  expect(box("Reading").props).toMatchObject({ checked: true, indeterminate: false, description: "library.categoryAction.inAll" });
  expect(box("Done").props).toMatchObject({ checked: false, indeterminate: true, description: "library.categoryAction.inSome" });
  expect(box("Later").props).toMatchObject({ checked: false, indeterminate: false });
  const apply = () => elements().find((element) => element.props.children === "common.apply")!;
  expect(apply().props.disabled).toBe(true);

  await harness.run(() => (box("Reading").props.onChange as () => void)());
  await harness.run(() => (box("Done").props.onChange as () => void)());
  await harness.run(() => (box("Later").props.onChange as () => void)());
  expect(box("Reading").props.description).toBe("library.categoryAction.willRemove");
  expect(box("Done").props.description).toBe("library.categoryAction.willAdd");
  expect(apply().props.disabled).toBe(false);

  await harness.run(() => (apply().props.onClick as () => void)());
  expect(onApply).toHaveBeenCalledWith({ add: [5, 6], remove: [4] });
});

it("marks the goal every selected novel shares and nothing when they differ", () => {
  const goals = [
    { novelId: 1, goal: { kind: "entire" as const }, updatedAt: 1 },
    { novelId: 2, goal: { kind: "entire" as const }, updatedAt: 2 },
    { novelId: 3, goal: { kind: "none" as const }, updatedAt: 3 },
  ];
  expect(sharedDownloadGoal([1, 2], goals)).toEqual({ kind: "entire" });
  expect(sharedDownloadGoal([1, 3], goals)).toBeUndefined();
  expect(sharedDownloadGoal([4, 5], goals)).toBeNull();
  expect(sharedDownloadGoal([1, 4], goals)).toBeUndefined();
});

it("applies a goal choice to the selection, or just closes on the goal they already share", async () => {
  mocks.data = [{ novelId: 1, goal: { kind: "entire" }, updatedAt: 1 }, { novelId: 2, goal: { kind: "entire" }, updatedAt: 1 }];
  const apply = vi.fn();
  const close = vi.fn();
  const downloadOnce = vi.fn();
  function GoalProbe() {
    tree = LibraryDownloadGoalSheet({
      applying: false, novelIds: [1, 2], onApply: apply, onClose: close, onDownloadOnce: downloadOnce, opened: true,
    }) as
      ReactElement<Record<string, unknown>>;
    return null;
  }
  harness = mountBackNavigationHarness();
  await harness.render(<GoalProbe />);
  const sections = elements().filter((element) => element.type === DownloadGoalSection);
  expect(sections.map((section) => section.props.title)).toEqual(["downloadGoals.section.goal", "downloadGoals.section.once"]);
  const [goalSection, onceSection] = sections as [ReactElement<{ children: ReactNode }>, ReactElement<{ children: ReactNode }>];
  const choices = goalSection.props.children as ReactElement<{
    current: unknown;
    onChoose: (goal: unknown) => void;
  }>;
  expect(choices.props.current).toEqual({ kind: "entire" });
  choices.props.onChoose({ kind: "entire" });
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  choices.props.onChoose({ kind: "none" });
  expect(apply).toHaveBeenCalledWith({ kind: "none" });

  const once = onceSection.props.children as ReactElement<{ onClick: () => void; title: string }>;
  expect(once.props.title).toBe("library.downloadOnce.title");
  once.props.onClick();
  expect(downloadOnce).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
});
