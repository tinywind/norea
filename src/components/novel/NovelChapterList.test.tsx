import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import { VirtualChapterList } from "./NovelChapterList";

const chapter: ChapterListRow = {
  id: 1,
  novelId: 1,
  path: "/chapter/1",
  name: "First chapter",
  chapterNumber: "1",
  position: 1,
  page: "1",
  bookmark: false,
  unread: true,
  progress: 0,
  isDownloaded: false,
  sourceContentType: "html",
  contentType: "html",
  contentBytes: 0,
  mediaBytes: 0,
  mediaRepairNeeded: false,
  releaseTime: null,
  readAt: null,
  createdAt: null,
  foundAt: 1,
  updatedAt: 1,
};

describe("chapter row controls", () => {
  it.each([false, true])(
    "keeps selection, dragging and download actions outside the primary button (downloaded: %s)",
    (isDownloaded) => {
      const $ = load(renderToStaticMarkup(
        <MantineProvider>
          <VirtualChapterList
            chapters={[
              { ...chapter, isDownloaded, mediaRepairNeeded: isDownloaded },
              { ...chapter, id: 2, position: 2, name: "Second chapter" },
            ]}
            canDeleteDownloads
            canReorderChapters
            deleteBusyChapterId={undefined}
            duplicateSourceChapterCounts={new Map()}
            deletePending={false}
            lastReadChapterId={undefined}
            repairBusyChapterId={undefined}
            repairPending={false}
            reorderPending={false}
            selectedChapterIds={new Set([1])}
            selectionMode
            statuses={new Map()}
            onDeleteDownload={vi.fn()}
            onDownload={vi.fn()}
            onOpen={vi.fn()}
            onRepairMedia={vi.fn()}
            onReorderChapter={vi.fn()}
            onToggleSelected={vi.fn()}
          />
        </MantineProvider>,
      ));
      const row = $(".norea-novel-chapter-row").first();
      const primary = row.children("button.norea-novel-chapter-open");

      expect(row.attr("role")).toBeUndefined();
      expect(row.attr("tabindex")).toBeUndefined();
      expect(primary).toHaveLength(1);
      expect(primary.attr("type")).toBe("button");
      expect(primary.attr("aria-pressed")).toBe("true");
      expect(primary.find("button, input, [tabindex]")).toHaveLength(0);
      expect(row.children("button.norea-novel-chapter-drag-handle")).toHaveLength(1);
      expect(row.find("input[type='checkbox']")).toHaveLength(1);
      expect(row.find(".norea-novel-chapter-actions button")).toHaveLength(
        isDownloaded ? 2 : 1,
      );
    },
  );
});
