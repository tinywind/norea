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
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
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
  return tree.filter((element) => element.props.label === label);
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

it("shows the History paused pill whenever reading history is paused", () => {
  expect(topBar().some((element) => element.props.children === "reader.incognito")).toBe(false);
  expect(topBar({ incognitoMode: true }).some((element) => element.props.children === "reader.incognito")).toBe(true);
});

it("shows the repair button only while chapter media needs repair", () => {
  expect(withLabel(topBar(), "reader.repairMedia")).toHaveLength(0);
  expect(withLabel(topBar({ showMediaRepair: true }), "reader.repairMedia")).toHaveLength(1);
});

it("reports the bookmark as a pressed toggle", () => {
  expect(withLabel(topBar(), "reader.bookmarkChapter")[0]!.props["aria-pressed"]).toBe(false);
  expect(withLabel(topBar({ bookmarked: true }), "reader.removeBookmark")[0]!.props["aria-pressed"]).toBe(true);
});

it("disables chapter steps at the ends of the chapter list and reports the chapter list state", () => {
  const tree = elements(ReaderBottomBar({
    chapterListExpanded: true, focusHandlers, hasNextChapter: true, hasPreviousChapter: false,
    onNextChapter: vi.fn(), onOpenChapters: vi.fn(), onOpenSettings: vi.fn(), onPreviousChapter: vi.fn(),
    seekSlotRef: vi.fn(), settingsOpen: false,
  }));
  expect(withLabel(tree, "reader.previousChapter")[0]!.props.disabled).toBe(true);
  expect(withLabel(tree, "reader.nextChapter")[0]!.props.disabled).toBe(false);
  expect(withLabel(tree, "reader.chapters")[0]!.props["aria-expanded"]).toBe(true);
  expect(withLabel(tree, "reader.openSettings")).toHaveLength(1);
});
