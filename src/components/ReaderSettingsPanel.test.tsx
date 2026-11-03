import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const hookState = vi.hoisted(() => ({ index: 0, slots: [] as unknown[] }));
const backState = vi.hoisted(() => ({ overlays: [] as Array<{ opened: boolean; onClose: () => void }> }));
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
vi.mock("../lib/android-back-navigation", () => ({
  useOverlayBackNavigation: (opened: boolean, onClose: () => void) => {
    backState.overlays.push({ opened, onClose });
  },
}));
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
import { useReaderStore } from "../store/reader";

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

function renderNovelPanel() {
  hookState.index = 0;
  backState.overlays = [];
  return elements(ReaderSettingsPanel({ target: readerTarget }));
}

function renderGlobalPanel() {
  hookState.index = 0;
  backState.overlays = [];
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

beforeEach(() => {
  hookState.slots = [];
  useReaderStore.getState().resetReaderSettings();
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

it("shows one heading per settings tab instead of repeating it inside the tab", () => {
  const tree = renderGlobalPanel();
  const titled = tree.filter(
    (element) => element.props.title === "readerSettings.reading.title" || element.props.title === "readerSettings.controls.title",
  );
  expect(titled).toHaveLength(0);
  expect(tree.some((element) => element.props.children === "readerSettings.reading.title")).toBe(true);
});

it("states the novel scope and leaves global settings when resetting an enabled novel override", () => {
  useReaderStore.getState().setAppearance({ textSize: 26 });
  useReaderStore.getState().setNovelAppearance(readerTarget.novelId, { textSize: 30 }, useReaderStore.getState().appearance);
  resetButton(renderNovelPanel()).props.onClick!();
  const tree = renderNovelPanel();
  expect(tree.some((element) => element.props.children === "readerSettings.reset.novelMessage")).toBe(true);
  expect(tree.some((element) => element.props.label === "readerSettings.reset.keepScopedSettings")).toBe(false);

  confirmResetButton(tree).props.onClick!();

  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toBeUndefined();
  expect(useReaderStore.getState().appearance.textSize).toBe(26);
});

it("closes the reset confirmation on back without resetting settings", () => {
  useReaderStore.getState().setAppearance({ textSize: 26 });
  resetButton(renderGlobalPanel()).props.onClick!();
  expect(resetModal(renderGlobalPanel()).props.opened).toBe(true);
  const openOverlays = backState.overlays.filter((overlay) => overlay.opened);
  expect(openOverlays).toHaveLength(1);

  openOverlays[0]!.onClose();

  expect(resetModal(renderGlobalPanel()).props.opened).toBe(false);
  expect(backState.overlays.some((overlay) => overlay.opened)).toBe(false);
  expect(useReaderStore.getState().appearance.textSize).toBe(26);
});
