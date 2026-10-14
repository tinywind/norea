import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
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

function renderChapterStatus(status: ChapterDownloadStatus) {
  return load(renderToStaticMarkup(
    <MantineProvider>
      <VirtualChapterList
        chapters={[{ ...chapter, releaseTime: "2026-10-12" }]}
        canDeleteDownloads
        canReorderChapters={false}
        deleteBusyChapterId={undefined}
        duplicateSourceChapterCounts={new Map()}
        deletePending={false}
        lastReadChapterId={undefined}
        repairBusyChapterId={undefined}
        repairPending={false}
        reorderPending={false}
        selectedChapterIds={new Set()}
        selectionMode={false}
        statuses={new Map([[chapter.id, status]])}
        onDeleteDownload={vi.fn()}
        onDownload={vi.fn()}
        onOpen={vi.fn()}
        onRepairMedia={vi.fn()}
        onReorderChapter={vi.fn()}
        onToggleSelected={vi.fn()}
      />
    </MantineProvider>,
  ));
}

describe("chapter download stage", () => {
  it.each<[
    ChapterDownloadStatus,
    string,
  ]>([
    [{ kind: "running", phase: "local" }, "Checking download status"],
    [{ kind: "running", phase: "server-lookup" }, "Checking content server"],
    [{ kind: "running", phase: "server-download" }, "Content server: downloading"],
    [{ kind: "running", phase: "source-download" }, "Original site: downloading"],
    [{ kind: "queued", phase: "local" }, "Download status check queued"],
    [{ kind: "queued", phase: "server-lookup" }, "Content server check queued"],
    [{ kind: "queued", phase: "server-download" }, "Content server download queued"],
    [{ kind: "queued", phase: "source-download" }, "Original site download queued"],
    [{ kind: "running" }, "Downloading"],
    [{ kind: "queued" }, "Queued"],
  ])("shows %j as visible text without hover", (status, expected) => {
    const $ = renderChapterStatus(status);
    const primary = $(".norea-novel-chapter-open");
    const description = primary.find(".norea-novel-chapter-download-status");

    expect(description.text()).toBe(expected);
    expect(primary.attr("aria-describedby")).toBe(description.attr("id"));
    expect(primary.find(".norea-novel-chapter-meta-row").text()).toBe(expected);
    expect(primary.find("button, input, [tabindex]")).toHaveLength(0);
    expect($(".norea-novel-chapter-actions button")).toHaveLength(0);
  });

  it("restores chapter metadata after the download finishes", () => {
    const $ = renderChapterStatus({ kind: "done" });

    expect($(".norea-novel-chapter-download-status")).toHaveLength(0);
    expect($(".norea-novel-chapter-open").attr("aria-describedby")).toBeUndefined();
    expect($(".norea-novel-chapter-meta-row").text()).toContain("2026-10-12");
  });
});
