import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const hookState = vi.hoisted(() => ({ index: 0, slots: [] as unknown[] }));
vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
});
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => {
    const index = hookState.index++;
    if (!(index in hookState.slots)) hookState.slots[index] = initial;
    return [hookState.slots[index], (value: unknown) => { hookState.slots[index] = value; }];
  },
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../store/reader", async (original) => {
  const actual = await original<typeof import("../store/reader")>();
  return {
    ...actual,
    useReaderStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useReaderStore.getState>) => unknown) =>
        selector(actual.useReaderStore.getState()),
      actual.useReaderStore,
    ),
  };
});

import { ReaderSettingsPanel } from "./ReaderSettingsPanel";
import { getEffectiveReaderAppearanceSettings, useReaderStore } from "../store/reader";

interface ElementProps {
  children?: ReactNode;
  title?: string;
  className?: string;
  label?: string;
  "aria-label"?: string;
  checked?: boolean;
  opened?: boolean;
  tone?: string;
  onClick?: () => void;
  value?: unknown;
  data?: Array<{ value: string; label: string }>;
  onChange?: (value: never) => void;
}

function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}

const readerTarget = { kind: "novel" as const, novelId: 7, sourceId: "source-a", sourceLabel: "Source A", label: "Work" };

function renderReaderPanel() {
  hookState.index = 0;
  return elements(ReaderSettingsPanel({ editEffectiveScope: true, inlineAutomation: true, target: readerTarget }));
}

function renderGlobalPanel() {
  hookState.index = 0;
  return elements(ReaderSettingsPanel());
}

function resetModal(tree: ReactElement<ElementProps>[]) {
  return tree.find((element) => element.props.title === "readerSettings.reset.title")!;
}

function resetButton(tree: ReactElement<ElementProps>[]) {
  return tree.find((element) => element.props.children === "common.reset" && element.props.tone !== "danger")!;
}

function confirmResetButton(tree: ReactElement<ElementProps>[]) {
  return tree.find((element) => element.props.children === "common.reset" && element.props.tone === "danger")!;
}

function scopeSwitch(tree: ReactElement<ElementProps>[]) {
  return tree.find((element) => element.props["aria-label"] === "readerSettings.scope.applyTo")!;
}

function textSizeSlider(tree: ReactElement<ElementProps>[]) {
  return tree.find((element) => element.props.label === "readerSettings.textSize")!;
}

function effectiveTextSize(): number {
  const state = useReaderStore.getState();
  return getEffectiveReaderAppearanceSettings(
    state.appearance,
    state.readerSettingsBySource[readerTarget.sourceId],
    state.readerSettingsByNovel[readerTarget.novelId],
  ).textSize;
}

beforeEach(() => {
  hookState.slots = [];
  useReaderStore.getState().resetReaderSettings();
});

it("edits global settings from the reader when no override exists", () => {
  const tree = renderReaderPanel();
  expect(tree.some((element) => element.props.className === "norea-reader-settings-disabled-notice")).toBe(false);
  expect(scopeSwitch(tree).props.value).toBe("global");
  expect(scopeSwitch(tree).props.data!.map((option) => option.value)).toEqual(["novel", "global"]);

  (textSizeSlider(tree).props.onChange as (value: number) => void)(24);

  expect(useReaderStore.getState().appearance.textSize).toBe(24);
  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toBeUndefined();
  expect(effectiveTextSize()).toBe(24);
});

it("creates a novel override from the effective values when choosing this novel", () => {
  useReaderStore.getState().setAppearance({ textSize: 24 });
  (scopeSwitch(renderReaderPanel()).props.onChange as (value: string) => void)("novel");

  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toEqual({ enabled: true });
  const tree = renderReaderPanel();
  expect(scopeSwitch(tree).props.value).toBe("novel");
  expect(textSizeSlider(tree).props.value).toBe(24);

  (textSizeSlider(tree).props.onChange as (value: number) => void)(30);

  expect(useReaderStore.getState().appearance.textSize).toBe(24);
  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]?.appearance?.textSize).toBe(30);
  expect(effectiveTextSize()).toBe(30);
});

it("edits an enabled source override and can switch the reader back to all novels", () => {
  useReaderStore.getState().setSourceAppearance(readerTarget.sourceId, { textSize: 20 });
  const tree = renderReaderPanel();
  expect(scopeSwitch(tree).props.value).toBe("source");
  expect(scopeSwitch(tree).props.data!.map((option) => option.value)).toEqual(["novel", "source", "global"]);
  expect(textSizeSlider(tree).props.value).toBe(20);

  (scopeSwitch(tree).props.onChange as (value: string) => void)("global");

  expect(useReaderStore.getState().readerSettingsBySource[readerTarget.sourceId]?.enabled).toBe(false);
  expect(scopeSwitch(renderReaderPanel()).props.value).toBe("global");
  expect(effectiveTextSize()).toBe(useReaderStore.getState().appearance.textSize);
});

it("asks for confirmation and keeps scoped settings when resetting global settings", () => {
  useReaderStore.getState().setAppearance({ textSize: 26 });
  useReaderStore.getState().setNovelAppearance(readerTarget.novelId, { textSize: 30 });
  useReaderStore.getState().setSourceAppearance(readerTarget.sourceId, { textSize: 20 });
  let tree = renderGlobalPanel();
  expect(resetModal(tree).props.opened).toBe(false);

  resetButton(tree).props.onClick!();

  expect(useReaderStore.getState().appearance.textSize).toBe(26);
  tree = renderGlobalPanel();
  expect(resetModal(tree).props.opened).toBe(true);
  const keep = tree.find((element) => element.props.label === "readerSettings.reset.keepScopedSettings")!;
  expect(keep.props.checked).toBe(true);

  confirmResetButton(tree).props.onClick!();

  const state = useReaderStore.getState();
  expect(state.appearance.textSize).not.toBe(26);
  expect(state.readerSettingsByNovel[readerTarget.novelId]?.appearance?.textSize).toBe(30);
  expect(state.readerSettingsBySource[readerTarget.sourceId]?.appearance?.textSize).toBe(20);
  expect(resetModal(renderGlobalPanel()).props.opened).toBe(false);
});

it("clears scoped settings on a global reset only when the keep option is unchecked", () => {
  useReaderStore.getState().setNovelAppearance(readerTarget.novelId, { textSize: 30 });
  resetButton(renderGlobalPanel()).props.onClick!();
  const keep = renderGlobalPanel().find((element) => element.props.label === "readerSettings.reset.keepScopedSettings")!;
  (keep.props.onChange as (event: { currentTarget: { checked: boolean } }) => void)({ currentTarget: { checked: false } });

  confirmResetButton(renderGlobalPanel()).props.onClick!();

  expect(useReaderStore.getState().readerSettingsByNovel).toEqual({});
});

it("states the novel scope and leaves global settings when resetting a novel override", () => {
  useReaderStore.getState().setAppearance({ textSize: 26 });
  useReaderStore.getState().setNovelAppearance(readerTarget.novelId, { textSize: 30 }, useReaderStore.getState().appearance);
  resetButton(renderReaderPanel()).props.onClick!();
  const tree = renderReaderPanel();
  expect(tree.some((element) => element.props.children === "readerSettings.reset.novelMessage")).toBe(true);
  expect(tree.some((element) => element.props.label === "readerSettings.reset.keepScopedSettings")).toBe(false);

  confirmResetButton(tree).props.onClick!();

  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toBeUndefined();
  expect(useReaderStore.getState().appearance.textSize).toBe(26);
});
