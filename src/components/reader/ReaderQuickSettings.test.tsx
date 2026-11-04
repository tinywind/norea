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
  color?: string;
  footer?: ReactNode;
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
  return [element, ...elements(element.props.children), ...elements(element.props.footer)];
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

/** The scope menu's own elements, rendered from the quick settings tree. */
function scopeMenu(tree: ReactElement<ElementProps>[]) {
  const menu = tree.find((element) => typeof element.type === "function" && element.type.name === "ReaderScopeMenu")!;
  return elements((menu.type as (props: unknown) => ReactNode)(menu.props));
}

function currentScope(tree: ReactElement<ElementProps>[]) {
  return scopeMenu(tree).find((element) => element.props["aria-current" as "title"] === "true")!.props.children;
}

function scopeItem(tree: ReactElement<ElementProps>[], label: string) {
  return scopeMenu(tree).find((element) => element.props.children === label && element.props.onClick)!;
}

const SCOPE_LABELS = {
  global: "readerSettings.scope.applyToAll",
  novel: "readerSettings.scope.applyToNovel",
  source: "readerSettings.scope.applyToSource",
} as const;

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
  expect(currentScope(tree)).toBe(SCOPE_LABELS.global);
  const scopeLabels: readonly unknown[] = Object.values(SCOPE_LABELS);
  expect(
    scopeMenu(tree)
      .filter((element) => element.props.onClick && scopeLabels.includes(element.props.children))
      .map((element) => element.props.children),
  ).toEqual([SCOPE_LABELS.global, SCOPE_LABELS.source, SCOPE_LABELS.novel]);
  expect(scopeMenu(tree).some((element) => element.props.children === "readerSettings.scope.useInherited")).toBe(false);

  (textSizeStepper(tree).props.onChange as (value: number) => void)(24);

  expect(useReaderStore.getState().appearance.textSize).toBe(24);
  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toBeUndefined();
  expect(effectiveTextSize()).toBe(24);
});

it("turns a novel override on from the effective values when choosing This novel", () => {
  useReaderStore.getState().setAppearance({ textSize: 24 });
  useReaderStore.setState({
    readerSettingsByNovel: { [readerTarget.novelId]: { appearance: { textSize: 40 }, enabled: false } },
  });
  scopeItem(renderQuick(), SCOPE_LABELS.novel).props.onClick!();

  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toEqual({ enabled: true });
  const tree = renderQuick();
  expect(currentScope(tree)).toBe(SCOPE_LABELS.novel);
  expect(textSizeStepper(tree).props.value).toBe(24);

  (textSizeStepper(tree).props.onChange as (value: number) => void)(30);

  expect(useReaderStore.getState().appearance.textSize).toBe(24);
  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]?.appearance?.textSize).toBe(30);
  expect(effectiveTextSize()).toBe(30);
});

it("turns a source override on when choosing This source", () => {
  scopeItem(renderQuick(), SCOPE_LABELS.source).props.onClick!();

  expect(useReaderStore.getState().readerSettingsBySource[readerTarget.sourceId]).toEqual({ enabled: true });
  expect(currentScope(renderQuick())).toBe(SCOPE_LABELS.source);
});

it("turns the edited source override off with Use inherited settings", () => {
  useReaderStore.getState().setSourceAppearance(readerTarget.sourceId, { textSize: 20 });
  const tree = renderQuick();
  expect(currentScope(tree)).toBe(SCOPE_LABELS.source);
  expect(textSizeStepper(tree).props.value).toBe(20);

  scopeItem(tree, "readerSettings.scope.useInherited").props.onClick!();

  expect(useReaderStore.getState().readerSettingsBySource[readerTarget.sourceId]?.enabled).toBe(false);
  expect(currentScope(renderQuick())).toBe(SCOPE_LABELS.global);
  expect(effectiveTextSize()).toBe(useReaderStore.getState().appearance.textSize);
});

it("copies this novel's settings to all novels and lets the novel follow them", () => {
  useReaderStore.getState().setSourceAppearance(readerTarget.sourceId, { lineHeight: 2 });
  useReaderStore.getState().startNovelReaderSettings(readerTarget.novelId);
  useReaderStore.getState().setNovelAppearance(readerTarget.novelId, { textSize: 30 }, {
    ...useReaderStore.getState().appearance,
    lineHeight: 2,
  });

  scopeItem(renderQuick(), "readerSettings.scope.useForAll").props.onClick!();

  const state = useReaderStore.getState();
  expect(state.appearance.textSize).toBe(30);
  expect(state.appearance.lineHeight).toBe(2);
  expect(state.readerSettingsByNovel[readerTarget.novelId]?.enabled).toBe(false);
  expect(currentScope(renderQuick())).toBe(SCOPE_LABELS.source);
  expect(effectiveTextSize()).toBe(30);
});

it("says when a narrower scope overrides the edited one and offers to edit it", () => {
  useReaderStore.getState().startNovelReaderSettings(readerTarget.novelId);
  useReaderStore.getState().setNovelAppearance(readerTarget.novelId, { textSize: 30 }, useReaderStore.getState().appearance);
  expect(scopeMenu(renderQuick()).some((element) => element.props.children === "readerSettings.scope.novelOverrides")).toBe(false);

  scopeItem(renderQuick(), SCOPE_LABELS.global).props.onClick!();
  let tree = renderQuick();
  expect(currentScope(tree)).toBe(SCOPE_LABELS.global);
  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]?.enabled).toBe(true);
  expect(scopeMenu(tree).some((element) => element.props.children === "readerSettings.scope.novelOverrides")).toBe(true);

  scopeMenu(tree).find((element) => element.props.children === "readerSettings.scope.editNovel")!.props.onClick!();
  tree = renderQuick();
  expect(currentScope(tree)).toBe(SCOPE_LABELS.novel);
  expect(scopeMenu(tree).some((element) => element.props.children === "readerSettings.scope.novelOverrides")).toBe(false);
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
  const reset = openMoreSettings().find((element) => element.props.children === "common.reset" && element.props.color !== "danger")!;
  reset.props.onClick!();
  const tree = renderQuick();
  expect(tree.some((element) => element.props.children === "readerSettings.reset.novelMessage")).toBe(true);
  tree.find((element) => element.props.children === "common.reset" && element.props.color === "danger")!.props.onClick!();

  expect(useReaderStore.getState().readerSettingsByNovel[readerTarget.novelId]).toBeUndefined();
  expect(useReaderStore.getState().appearance.textSize).toBe(26);
});
