import type { ReactElement, ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { ChapterRow } from "../../db/queries/chapter";

vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../ReaderSettingsPanel", () => ({ ReaderSettingsPanel: () => null }));

import { ReaderTopChrome } from "./ReaderChrome";

interface ElementProps { children?: ReactNode; className?: string }

function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}

const chapter = {
  id: 11, novelId: 7, position: 3, name: "Chapter three", path: "/chapter/3", chapterNumber: "3",
  isDownloaded: true, bookmark: false, unread: true, progress: 0,
} as unknown as ChapterRow;

function topChrome(overrides: { chapter?: ChapterRow; novelName?: string; showMediaRepair?: boolean }) {
  return elements(ReaderTopChrome({
    chapter: overrides.chapter ?? chapter, chapterCount: 12, chapterIndex: 2, novelName: overrides.novelName,
    bookmarkDisabled: false, bookmarkLoading: false, incognitoMode: false, onBack: vi.fn(), onOpenSettings: vi.fn(),
    onRepairMedia: vi.fn(), onToggleBookmark: vi.fn(), progress: 40, repairMediaDisabled: false,
    repairMediaLoading: false, repairMediaAttention: false, settingsOpen: false,
    showMediaRepair: overrides.showMediaRepair ?? false,
  }));
}

function readerMeta(overrides: { chapter?: ChapterRow; novelName?: string }) {
  return topChrome(overrides).find((element) => element.props.className === "norea-reader-meta")!.props.children;
}

it("shows the novel name and position without an offline label for a stored chapter", () => {
  expect(readerMeta({ novelName: "The Work" })).toBe("The Work / 3 / 12");
});

it("omits a missing novel name and keeps the not-downloaded status", () => {
  expect(readerMeta({ chapter: { ...chapter, isDownloaded: false } })).toBe("3 / 12 / reader.notDownloaded");
});

it("gives every top chrome button the state layer that replaces the tap highlight", () => {
  const buttons = topChrome({ showMediaRepair: true })
    .filter((element) => element.props.className?.includes("norea-reader-icon-button"));
  expect(buttons).toHaveLength(4);
  for (const button of buttons) expect(button.props.className).toContain("norea-state-layer");
});
