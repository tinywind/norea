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
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/android-back-navigation", () => ({
  useOverlayBackNavigation: (opened: boolean, onClose: () => void) => {
    backState.overlays.push({ opened, onClose });
  },
}));
vi.mock("../../store/reader", async (original) => {
  const actual = await original<typeof import("../../store/reader")>();
  return {
    ...actual,
    useReaderStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useReaderStore.getState>) => unknown) =>
        selector(actual.useReaderStore.getState()),
      actual.useReaderStore,
    ),
  };
});

import { ReaderQuickSettings } from "./ReaderQuickSettings";
import { getEffectiveReaderAppearanceSettings, useReaderStore } from "../../store/reader";

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
const htmlContent = { kind: "html" as const, hasImages: false };

function renderQuick(content: { kind: "html" | "pdf"; hasImages: boolean } = htmlContent) {
  hookState.index = 0;
  backState.overlays = [];
  return elements(ReaderQuickSettings({ content, target: readerTarget }));
}

function openMoreSettings(content?: { kind: "html" | "pdf"; hasImages: boolean }) {
  const more = renderQuick(content).find((element) => element.props.className === "norea-reader-quick-more norea-state-layer")!;
  more.props.onClick!();
  return renderQuick(content);
}

function scopeSwitch(tree: ReactElement<ElementProps>[]) {
  return tree.find((element) => element.props["aria-label"] === "readerSettings.scope.applyTo")!;
}

function textSizeStepper(tree: ReactElement<ElementProps>[]) {
  return tree.find((element) => element.props.label === "readerSettings.quickTextSize")!;
}

function hasLabel(tree: ReactElement<ElementProps>[], label: string) {
  return tree.some((element) => element.props.label === label);
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
  const tree = renderQuick();
  expect(scopeSwitch(tree).props.value).toBe("global");
  expect(scopeSwitch(tree).props.data!.map((option) => option.value)).toEqual(["novel", "global"]);

  (textSizeStepper(tree).props.onChange as (value: number) => void)(24);

  expect(useReaderStore.getState().appearance.textSize).toBe(24);
  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toBeUndefined();
  expect(effectiveTextSize()).toBe(24);
});

it("creates a novel override from the effective values when choosing this novel", () => {
  useReaderStore.getState().setAppearance({ textSize: 24 });
  (scopeSwitch(renderQuick()).props.onChange as (value: string) => void)("novel");

  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toEqual({ enabled: true });
  const tree = renderQuick();
  expect(scopeSwitch(tree).props.value).toBe("novel");
  expect(textSizeStepper(tree).props.value).toBe(24);

  (textSizeStepper(tree).props.onChange as (value: number) => void)(30);

  expect(useReaderStore.getState().appearance.textSize).toBe(24);
  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]?.appearance?.textSize).toBe(30);
  expect(effectiveTextSize()).toBe(30);
});

it("edits an enabled source override and can switch the reader back to all novels", () => {
  useReaderStore.getState().setSourceAppearance(readerTarget.sourceId, { textSize: 20 });
  const tree = renderQuick();
  expect(scopeSwitch(tree).props.value).toBe("source");
  expect(scopeSwitch(tree).props.data!.map((option) => option.value)).toEqual(["novel", "source", "global"]);
  expect(textSizeStepper(tree).props.value).toBe(20);

  (scopeSwitch(tree).props.onChange as (value: string) => void)("global");

  expect(useReaderStore.getState().readerSettingsBySource[readerTarget.sourceId]?.enabled).toBe(false);
  expect(scopeSwitch(renderQuick()).props.value).toBe("global");
  expect(effectiveTextSize()).toBe(useReaderStore.getState().appearance.textSize);
});

it("keeps size, theme and mode in the first level and auto-scroll only in scroll mode", () => {
  let tree = renderQuick();
  expect(textSizeStepper(tree)).toBeDefined();
  expect(tree.some((element) => element.props["aria-label"] === "readerSettings.readingMode")).toBe(true);
  expect(tree.some((element) => element.props["aria-label"] === "readerSettings.theme.dark")).toBe(true);
  expect(hasLabel(tree, "readerSettings.autoScroll")).toBe(true);

  useReaderStore.getState().setGeneral({ pageReader: true });
  tree = renderQuick();
  expect(hasLabel(tree, "readerSettings.autoScroll")).toBe(false);
});

it("applies a theme from its swatch", () => {
  const sepia = renderQuick().find((element) => element.props["aria-label"] === "readerSettings.theme.sepia")!;
  sepia.props.onClick!();
  expect(useReaderStore.getState().appearance.themeId).toBe("sepia");
});

it("hides page transition in scroll mode and shows it in paged mode", () => {
  expect(hasLabel(openMoreSettings(), "readerSettings.pageTransitionDuration")).toBe(false);
  hookState.slots = [];
  useReaderStore.getState().setGeneral({ pageReader: true });
  expect(hasLabel(openMoreSettings(), "readerSettings.pageTransitionDuration")).toBe(true);
});

it("shows PDF fit only for PDF chapters and image paging only for HTML with images", () => {
  useReaderStore.getState().setGeneral({ pageReader: true });
  let tree = openMoreSettings();
  expect(hasLabel(tree, "readerSettings.pdfPageFitMode")).toBe(false);
  expect(hasLabel(tree, "readerSettings.htmlImagePagingMode")).toBe(false);

  hookState.slots = [];
  tree = openMoreSettings({ kind: "pdf", hasImages: false });
  expect(hasLabel(tree, "readerSettings.pdfPageFitMode")).toBe(true);
  expect(hasLabel(tree, "readerSettings.htmlImagePagingMode")).toBe(false);

  hookState.slots = [];
  tree = openMoreSettings({ kind: "html", hasImages: true });
  expect(hasLabel(tree, "readerSettings.pdfPageFitMode")).toBe(false);
  expect(hasLabel(tree, "readerSettings.htmlImagePagingMode")).toBe(true);
});

it("opens More settings inside the same surface, with sections and a way back", () => {
  const tree = openMoreSettings();
  for (const title of [
    "readerSettings.reading.title",
    "readerSettings.controls.title",
    "readerSettings.indicators.title",
    "readerSettings.colors.title",
    "readerSettings.advanced",
  ]) {
    expect(tree.some((element) => element.props.children === title), title).toBe(true);
  }
  const back = tree.find((element) => element.props.className === "norea-reader-icon-button norea-state-layer" && element.props.onClick)!;
  back.props.onClick!();
  expect(textSizeStepper(renderQuick())).toBeDefined();
});

it("resets the scope the reader applies from the More settings footer", () => {
  useReaderStore.getState().setAppearance({ textSize: 26 });
  useReaderStore.getState().setNovelAppearance(readerTarget.novelId, { textSize: 30 }, useReaderStore.getState().appearance);
  const reset = openMoreSettings().find((element) => element.props.children === "common.reset" && element.props.tone !== "danger")!;
  reset.props.onClick!();
  const tree = renderQuick();
  expect(tree.some((element) => element.props.children === "readerSettings.reset.novelMessage")).toBe(true);
  tree.find((element) => element.props.children === "common.reset" && element.props.tone === "danger")!.props.onClick!();

  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toBeUndefined();
  expect(useReaderStore.getState().appearance.textSize).toBe(26);
});
