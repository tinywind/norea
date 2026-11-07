import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { NovelDownloadGoal } from "../db/queries/novel-download-goal";

const hooks = vi.hoisted(() => ({ index: 0, slots: [] as unknown[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
  },
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { DownloadGoalChoices } from "./DownloadGoalChoices";
import { SegmentedToggle } from "./SegmentedToggle";
import { ListRow } from "./ui/ListRow";

interface Props {
  "aria-checked"?: boolean;
  children?: ReactNode;
  disabled?: boolean;
  onChange?: (value: string) => void;
  onClick?: () => void;
  title?: string;
  value?: string;
  data?: Array<{ value: string }>;
}
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children)];
}
const onChoose = vi.fn();
function render(current: NovelDownloadGoal = { kind: "none" }, disabled = false) {
  hooks.index = 0;
  return elements(DownloadGoalChoices({ current, disabled, onChoose }));
}
beforeEach(() => { hooks.slots = []; onChoose.mockClear(); });

it("offers one global policy with no inherited or per-work default choice", () => {
  const rows = render({ kind: "entire" }).filter(element => element.type === ListRow);
  expect(rows.map(row => row.props.title)).toEqual([
    "downloadGoals.kind.none", "downloadGoals.kind.keepAhead", "downloadGoals.kind.allRemaining", "downloadGoals.kind.entire",
  ]);
  expect(rows.filter(row => row.props["aria-checked"]).map(row => row.props.title)).toEqual(["downloadGoals.kind.entire"]);
  rows[0]!.props.onClick!();
  expect(onChoose).toHaveBeenCalledExactlyOnceWith({ kind: "none" });
});

it("keeps supported saved counts visible and changes the shared policy when a count is chosen", () => {
  const toggle = render({ kind: "keep_ahead", count: 30 }).find(element => element.type === SegmentedToggle)!;
  expect(toggle.props.value).toBe("30");
  expect(toggle.props.data?.map(item => item.value)).toEqual(["1", "3", "5", "10", "30"]);
  toggle.props.onChange!("10");
  expect(onChoose).toHaveBeenCalledExactlyOnceWith({ kind: "keep_ahead", count: 10 });
});

it("disables policy controls only for the settings operation's busy state", () => {
  const controls = render({ kind: "none" }, true).filter(element => element.type === ListRow || element.type === SegmentedToggle);
  expect(controls).toHaveLength(5);
  expect(controls.every(element => element.props.disabled)).toBe(true);
});
