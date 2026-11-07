import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], navigate: vi.fn(), choose: vi.fn(), close: vi.fn(), select: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.index++;
    if (!(index in mocks.slots)) mocks.slots[index] = initial;
    return [mocks.slots[index], (value: unknown) => { mocks.slots[index] = value; }];
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../i18n", () => ({ useTranslation: () => ({
  t: (key: string, values?: Record<string, unknown>) => values ? `${key}(${JSON.stringify(values)})` : key,
}) }));

import { DownloadOnceChoices } from "./DownloadOnceChoices";
import { SegmentedToggle } from "./SegmentedToggle";
import { ListRow } from "./ui/ListRow";
interface Props { children?: ReactNode; disabled?: boolean; onChange?: (value: string) => void; onClick?: () => void; title?: string; role?: string }
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children)];
}
function render(disabled = false, selection = true) {
  mocks.index = 0;
  return elements(DownloadOnceChoices({ disabled, onChoose: mocks.choose, onClose: mocks.close,
    onSelectChapters: selection ? mocks.select : undefined }));
}
const row = (tree: ReactElement<Props>[], title: string) => tree.find(element => element.type === ListRow && element.props.title === title)!;
beforeEach(() => { vi.clearAllMocks(); mocks.slots = []; });

it("chooses a one-time range only after its action is pressed, not when the count changes", () => {
  render().find(element => element.type === SegmentedToggle)!.props.onChange!("10");
  expect(mocks.choose).not.toHaveBeenCalled();
  row(render(), 'downloadOnce.next({"count":10})').props.onClick!();
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith({ kind: "next", count: 10 });
  expect(mocks.close).not.toHaveBeenCalled();
});

it("offers immediate remaining and all ranges without an automatic policy radio group", () => {
  const tree = render(false, false);
  row(tree, "downloadOnce.remaining").props.onClick!();
  row(tree, "downloadOnce.all").props.onClick!();
  expect(mocks.choose.mock.calls).toEqual([[{ kind: "remaining" }], [{ kind: "all" }]]);
  expect(tree.some(element => element.props.role === "radio" || element.props.role === "radiogroup")).toBe(false);
  expect(tree.some(element => element.props.title === "downloadGoals.once.selected")).toBe(false);
});

it("keeps the settings link available when source download actions cannot run", () => {
  const tree = render(true);
  expect(row(tree, "downloadOnce.all").props.disabled).toBe(true);
  const settings = row(tree, "downloadOnce.settings");
  expect(settings.props.disabled).not.toBe(true);
  settings.props.onClick!();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings", search: { section: "downloads" } });
  expect(mocks.choose).not.toHaveBeenCalled();
});

it("hands a work's explicit chapter choice back to its chapter list", () => {
  row(render(), "downloadGoals.once.selected").props.onClick!();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.select).toHaveBeenCalledOnce();
  expect(mocks.choose).not.toHaveBeenCalled();
});
