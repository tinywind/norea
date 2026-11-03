import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

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
  className?: string;
  label?: string;
  "aria-label"?: string;
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
  return elements(ReaderSettingsPanel({ editEffectiveScope: true, inlineAutomation: true, target: readerTarget }));
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
