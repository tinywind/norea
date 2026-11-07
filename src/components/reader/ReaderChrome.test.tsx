import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import { expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: <T,>(initial: T) => [initial, vi.fn()],
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./ReaderQuickSettings", () => ({ ReaderQuickSettings: () => null }));

import { ReaderBottomBar, ReaderTopBar } from "./ReaderChrome";

interface ElementProps {
  children?: ReactNode;
  className?: string;
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
  "aria-label"?: string;
  "data-active"?: boolean;
}

function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}

const focusHandlers = { onFocus: vi.fn(), onBlur: vi.fn() };

function topBar(overrides: Partial<Parameters<typeof ReaderTopBar>[0]> = {}) {
  return elements(ReaderTopBar({
    bookmarked: false, bookmarkDisabled: false, bookmarkLoading: false, chapterName: "Chapter three",
    focusHandlers, incognitoMode: false, novelName: "The Work", onBack: vi.fn(), onIncognitoModeChange: vi.fn(),
    onOpenSettings: vi.fn(), onRepairMedia: vi.fn(), onToggleBookmark: vi.fn(), repairMediaAttention: false,
    repairMediaDisabled: false, repairMediaLoading: false, settingsOpen: false, showMediaRepair: false,
    ...overrides,
  }));
}

function withClass(tree: ReactElement<ElementProps>[], className: string) {
  return tree.find((element) => element.props.className === className)?.props.children;
}

function withLabel(tree: ReactElement<ElementProps>[], label: string) {
  return tree.filter((element) => (element.props.label ?? element.props["aria-label"]) === label);
}

it("shows the novel name over the chapter name", () => {
  const tree = topBar();
  expect(withClass(tree, "norea-reader-title")).toBe("The Work");
  expect(withClass(tree, "norea-reader-subtitle")).toBe("Chapter three");
});

it("falls back to the chapter name alone without a novel name", () => {
  const tree = topBar({ novelName: undefined });
  expect(withClass(tree, "norea-reader-title")).toBe("Chapter three");
  expect(withClass(tree, "norea-reader-subtitle")).toBeUndefined();
});

it.each([false, true])("toggles paused history directly and reports its current state: %s", (incognitoMode) => {
  const onIncognitoModeChange = vi.fn();
  const toggle = withLabel(topBar({ incognitoMode, onIncognitoModeChange }), "more.pauseHistory")[0]!;
  expect(toggle.props["aria-pressed"]).toBe(incognitoMode);
  toggle.props.onClick!();
  expect(onIncognitoModeChange).toHaveBeenCalledWith(!incognitoMode);
});

it("shows the repair button only while chapter media needs repair", () => {
  expect(withLabel(topBar(), "reader.repairMedia")).toHaveLength(0);
  expect(withLabel(topBar({ showMediaRepair: true }), "reader.repairMedia")).toHaveLength(1);
});

it("reports the bookmark as a pressed toggle", () => {
  expect(withLabel(topBar(), "reader.bookmarkChapter")[0]!.props["aria-pressed"]).toBe(false);
  expect(withLabel(topBar({ bookmarked: true }), "reader.removeBookmark")[0]!.props["aria-pressed"]).toBe(true);
});

it.each([
  { hasPreviousChapter: false, hasNextChapter: true, chapterListExpanded: true, settingsOpen: false },
  { hasPreviousChapter: true, hasNextChapter: false, chapterListExpanded: false, settingsOpen: true },
])("keeps labeled chapter actions, boundary guards and expanded states: %j", (state) => {
  const onPreviousChapter = vi.fn();
  const onNextChapter = vi.fn();
  const onOpenChapters = vi.fn();
  const onOpenSettings = vi.fn();
  const seekSlotRef = vi.fn();
  const footer = ReaderBottomBar({
    ...state, focusHandlers, onNextChapter, onOpenChapters, onOpenSettings, onPreviousChapter, seekSlotRef,
  });
  const tree = elements(footer);
  const previous = withLabel(tree, "reader.previousChapter")[0]!;
  const next = withLabel(tree, "reader.nextChapter")[0]!;
  const chapters = withLabel(tree, "reader.chapters")[0]!;
  const settings = withLabel(tree, "reader.openSettings")[0]!;

  expect(previous.props.children).toBe("reader.previousShort");
  expect(next.props.children).toBe("reader.nextShort");
  expect(chapters.props.children).toBe("reader.chapters");
  expect(settings.props.children).toBe("reader.settingsShort");
  expect(previous.props.disabled).toBe(!state.hasPreviousChapter);
  expect(next.props.disabled).toBe(!state.hasNextChapter);
  expect(chapters.props["aria-expanded"]).toBe(state.chapterListExpanded);
  expect(chapters.props["data-active"]).toBe(state.chapterListExpanded || undefined);
  expect(settings.props["aria-expanded"]).toBe(state.settingsOpen);
  expect(settings.props["data-active"]).toBe(state.settingsOpen || undefined);
  expect(previous.props.onClick).toBe(onPreviousChapter);
  expect(next.props.onClick).toBe(onNextChapter);
  expect(chapters.props.onClick).toBe(onOpenChapters);
  expect(settings.props.onClick).toBe(onOpenSettings);
  expect(footer.props.onFocus).toBe(focusHandlers.onFocus);
  expect(footer.props.onBlur).toBe(focusHandlers.onBlur);
  expect(footer.props.children[1].props.ref).toBe(seekSlotRef);
  expect(footer.props.children.map((child: ReactElement<ElementProps>) =>
    child.props["aria-label"] ?? child.props.className,
  )).toEqual([
    "reader.previousChapter", "norea-reader-seek-slot", "reader.nextChapter", "reader.chapters", "reader.openSettings",
  ]);
});

it("centers the bottom bar position label when no horizontal seekbar shares its slot", () => {
  const css = readFileSync(new URL("../../styles/reader.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.norea-reader-seek-label:only-child \{\s*margin-inline: auto;/);
  expect(css).toContain('grid-template-areas: "previous seek next chapters settings";');
  expect(css).toMatch(/\.norea-reader-footer-action\.mantine-Button-root \{[^}]*min-height: var\(--norea-control-md\);[^}]*min-width: var\(--norea-control-md\);/);
  expect(css).toMatch(/\.norea-reader-footer-action \.mantine-Button-inner \{\s*flex-direction: column;/);
});
