import { Loader, Skeleton } from "@mantine/core";
import type { LibraryUpdateEntry } from "../../db/queries/chapter";
import { formatRelativeTimeForLocale, useTranslation } from "../../i18n";
import type { ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { useNovelCoverSource } from "../../lib/use-novel-cover-source";
import { ConsoleCover } from "../ConsolePrimitives";
import { IconButton } from "../IconButton";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  DownloadedIcon,
  RetryIcon,
} from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { OverflowMenu } from "../ui/OverflowMenu";

const SKELETON_ROWS = 6;

function UpdateCover({
  entry,
  onOpenNovel,
}: {
  entry: LibraryUpdateEntry;
  onOpenNovel: () => void;
}) {
  const { t } = useTranslation();
  const coverSource = useNovelCoverSource({
    cover: entry.novelCover,
    id: entry.novelId,
    isLocal: entry.novelIsLocal,
    name: entry.novelName,
    path: entry.novelPath,
    pluginId: entry.pluginId,
  });

  return (
    <button
      aria-label={t("updates.openNovel", { name: entry.novelName })}
      className="norea-updates-cover norea-state-layer"
      onClick={onOpenNovel}
      type="button"
    >
      <ConsoleCover alt={entry.novelName} height={66} src={coverSource} width={44} />
    </button>
  );
}

function UpdateMeta({ entry }: { entry: LibraryUpdateEntry }) {
  const { locale } = useTranslation();

  return (
    <span className="norea-updates-row-meta">
      {entry.pluginName ?? entry.pluginId} ·{" "}
      {formatRelativeTimeForLocale(locale, entry.foundAt)}
    </span>
  );
}

function UpdateDownloadControl({
  downloaded,
  onDownload,
  status,
}: {
  downloaded: boolean;
  onDownload: () => void;
  status: ChapterDownloadStatus | undefined;
}) {
  const { t } = useTranslation();

  if (downloaded || status?.kind === "done") {
    return (
      <span
        aria-label={t("novel.downloaded")}
        className="norea-updates-download-slot"
        role="img"
        title={t("novel.downloaded")}
      >
        <DownloadedIcon size="1.25rem" />
      </span>
    );
  }
  if (status?.kind === "queued" || status?.kind === "running") {
    const label = status.kind === "running" ? t("common.downloading") : t("common.queued");
    return (
      <span
        aria-label={label}
        className="norea-updates-download-slot"
        role="status"
        title={label}
      >
        <Loader aria-hidden="true" size="xs" />
      </span>
    );
  }
  if (status?.kind === "failed") {
    return (
      <IconButton
        label={t("novel.retryDownload")}
        onClick={onDownload}
        size="lg"
        title={`${t("novel.retryDownload")}: ${status.error}`}
        tone="danger"
      >
        <RetryIcon size="1.25rem" />
      </IconButton>
    );
  }
  return (
    <IconButton label={t("novel.downloadChapter")} onClick={onDownload} size="lg">
      <DownloadIcon size="1.25rem" />
    </IconButton>
  );
}

interface UpdateRowProps {
  downloadStatus: ChapterDownloadStatus | undefined;
  entry: LibraryUpdateEntry;
  /** Rows inside an expanded run leave the novel's cover to the run row. */
  nested?: boolean;
  onDownload: () => void;
  onOpen: () => void;
  onOpenNovel: () => void;
}

/**
 * One new chapter. The cover opens the novel, the row body opens the reader,
 * and the download control and overflow sit beside the row, not inside it.
 */
export function UpdateRow({
  downloadStatus,
  entry,
  nested = false,
  onDownload,
  onOpen,
  onOpenNovel,
}: UpdateRowProps) {
  const { t } = useTranslation();

  return (
    <div className="norea-updates-row" data-nested={nested ? "true" : undefined}>
      {nested ? null : <UpdateCover entry={entry} onOpenNovel={onOpenNovel} />}
      <ListRow
        className="norea-updates-row-open"
        onClick={onOpen}
        subtitle={
          <>
            <span className="norea-updates-row-chapter">{entry.chapterName}</span>
            <UpdateMeta entry={entry} />
          </>
        }
        title={nested ? entry.chapterName : entry.novelName}
      />
      <div className="norea-updates-row-trailing">
        <UpdateDownloadControl
          downloaded={entry.isDownloaded}
          onDownload={onDownload}
          status={downloadStatus}
        />
        <OverflowMenu
          items={[{ label: t("updates.openNovelAction"), onClick: onOpenNovel }]}
          label={t("updates.rowMore", { name: entry.chapterName })}
        />
      </div>
    </div>
  );
}

interface UpdateRunRowProps {
  earliest: LibraryUpdateEntry;
  count: number;
  expanded: boolean;
  onOpenEarliest: () => void;
  onOpenNovel: () => void;
  onToggle: () => void;
}

/** A collapsed run of one novel's new chapters on one day. */
export function UpdateRunRow({
  count,
  earliest,
  expanded,
  onOpenEarliest,
  onOpenNovel,
  onToggle,
}: UpdateRunRowProps) {
  const { t } = useTranslation();

  return (
    <div className="norea-updates-row" data-run="true">
      <UpdateCover entry={earliest} onOpenNovel={onOpenNovel} />
      <ListRow
        className="norea-updates-row-open"
        onClick={onOpenEarliest}
        subtitle={
          <>
            <span className="norea-updates-row-chapter">
              {t("updates.runStartsAt", { name: earliest.chapterName })}
            </span>
            <UpdateMeta entry={earliest} />
          </>
        }
        title={t("updates.runTitle", { count, name: earliest.novelName })}
      />
      <div className="norea-updates-row-trailing">
        <IconButton
          aria-expanded={expanded}
          label={
            expanded
              ? t("updates.collapseRun", { name: earliest.novelName })
              : t("updates.expandRun", { name: earliest.novelName })
          }
          onClick={onToggle}
          size="lg"
        >
          {expanded ? <ChevronUpIcon size="1.25rem" /> : <ChevronDownIcon size="1.25rem" />}
        </IconButton>
      </div>
    </div>
  );
}

export function UpdateRowsSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div className="norea-updates-row norea-updates-row-skeleton" key={index}>
          <Skeleton height="4.125rem" radius="sm" width="2.75rem" />
          <div className="norea-updates-row-skeleton-text">
            <Skeleton height="0.875rem" radius="sm" width="45%" />
            <Skeleton height="0.75rem" radius="sm" width="70%" />
            <Skeleton height="0.625rem" radius="sm" width="30%" />
          </div>
        </div>
      ))}
    </div>
  );
}
