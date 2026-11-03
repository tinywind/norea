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

function readerMeta(overrides: { chapter?: ChapterRow; novelName?: string }) {
  const tree = elements(ReaderTopChrome({
    chapter: overrides.chapter ?? chapter, chapterCount: 12, chapterIndex: 2, novelName: overrides.novelName,
    bookmarkDisabled: false, bookmarkLoading: false, incognitoMode: false, onBack: vi.fn(), onOpenSettings: vi.fn(),
    onRepairMedia: vi.fn(), onToggleBookmark: vi.fn(), progress: 40, repairMediaDisabled: false,
    repairMediaLoading: false, repairMediaAttention: false, settingsOpen: false, showMediaRepair: false,
  }));
  return tree.find((element) => element.props.className === "norea-reader-meta")!.props.children;
}

it("shows the novel name and position without an offline label for a stored chapter", () => {
  expect(readerMeta({ novelName: "The Work" })).toBe("The Work / 3 / 12");
});

it("omits a missing novel name and keeps the not-downloaded status", () => {
  expect(readerMeta({ chapter: { ...chapter, isDownloaded: false } })).toBe("3 / 12 / reader.notDownloaded");
});
