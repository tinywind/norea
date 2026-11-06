import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ index: 0, slots: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
  },
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../store/download-goals", () => ({
  useDownloadGoalSettingsStore: (select: (state: { defaultKeepAhead: number }) => unknown) => select({ defaultKeepAhead: 3 }),
}));

import { DownloadGoalChoices, sharedDownloadGoal } from "./DownloadGoalChoices";
import { SegmentedToggle } from "./SegmentedToggle";
import { ListRow } from "./ui/ListRow";

interface Props {
  "aria-busy"?: boolean;
  children?: ReactNode;
  leading?: ReactElement<{ className?: string }>;
  onChange?: (value: string) => void;
  onClick?: () => void;
  title?: string;
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children)];
}

const onChoose = vi.fn();
function render(pending: boolean) {
  hooks.index = 0;
  return elements(DownloadGoalChoices({
    allRemainingDescription: "", current: null, disabled: pending, entireDescription: "", onChoose, pending,
  }));
}
const row = (tree: ReactElement<Props>[], title: string) =>
  tree.find((element) => element.type === ListRow && element.props.title === title)!;

beforeEach(() => {
  hooks.slots = [];
  onChoose.mockClear();
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

it("chooses keep-ahead with the count picked, even when another goal is active", () => {
  const toggle = render(false).find((element) => element.type === SegmentedToggle)!;
  toggle.props.onChange!("10");
  expect(onChoose).toHaveBeenCalledWith({ kind: "keep_ahead", count: 10 });
});

it("marks only the tapped row as in progress while the choice is written", () => {
  row(render(false), "downloadGoals.kind.entire").props.onClick!();
  expect(onChoose).toHaveBeenCalledWith({ kind: "entire" });
  const tree = render(true);
  expect(row(tree, "downloadGoals.kind.entire").props["aria-busy"]).toBe(true);
  expect(row(tree, "downloadGoals.kind.entire").props.leading!.props.className).toBe("norea-download-goal-pending");
  expect(row(tree, "downloadGoals.kind.none").props["aria-busy"]).toBeUndefined();
  expect(row(render(false), "downloadGoals.kind.entire").props["aria-busy"]).toBeUndefined();
});
