import { Button, Skeleton } from "@mantine/core";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { pluginManager } from "../../lib/plugins/manager";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { useNovelCoverSource } from "../../lib/use-novel-cover-source";
import { ConsoleCover } from "../ConsolePrimitives";
import {
  AddToLibraryIcon,
  DownloadIcon,
  FromStartIcon,
  InLibraryIcon,
  PlayIcon,
} from "../ui/icons";
import {
  buildBatchDownloadTargets,
  findContinueReadingChapter,
  findFirstChapter,
  formatChapterNumber,
  getNovelReadingPercent,
  hasReadingHistory,
  novelStatusLabel,
  splitGenres,
  type BatchDownloadOption,
} from "./novel-detail-model";
import { NovelDownloadSheet } from "./NovelActions";

interface NovelWorkspaceProps {
  allowSourceAccess: boolean;
  /** Category chips, shown under the title while the novel is in the library. */
  categoryChips?: ReactNode;
  chapters: ChapterListRow[];
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>;
  lastReadChapterId: number | undefined;
  libraryBusy: boolean;
  novel: NovelDetailRecord;
  onBatchDownload: (chapters: ChapterListRow[]) => void;
  onRead: (chapter: ChapterListRow) => void;
  onToggleLibrary: () => void;
  sourceName: string;
  titleRef?: Ref<HTMLHeadingElement>;
}

/**
 * The novel's header zone: cover, identity, the Continue action, the library,
 * download and from-start actions, and the clamped summary with genres.
 */
export function NovelWorkspace({
  allowSourceAccess,
  categoryChips,
  chapters,
  downloadStatuses,
  lastReadChapterId,
  libraryBusy,
  novel,
  onBatchDownload,
  onRead,
  onToggleLibrary,
  sourceName,
  titleRef,
}: NovelWorkspaceProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [downloadSheetOpen, setDownloadSheetOpen] = useState(false);
  const coverPlugin =
    !allowSourceAccess || novel.isLocal
      ? null
      : pluginManager.getPlugin(novel.pluginId);
  const coverSource = useNovelCoverSource(novel, {
    allowSourceFallback: Boolean(coverPlugin),
    plugin: coverPlugin,
  });
  const genres = useMemo(() => splitGenres(novel.genres), [novel.genres]);
  const firstChapter = useMemo(() => findFirstChapter(chapters), [chapters]);
  const continueReadingChapter = useMemo(
    () => findContinueReadingChapter(chapters, lastReadChapterId),
    [chapters, lastReadChapterId],
  );
  const hasHistory = hasReadingHistory(chapters, lastReadChapterId);
  const readPercent = useMemo(
    () => getNovelReadingPercent(chapters),
    [chapters],
  );
  const batchTargets = useMemo(
    () =>
      buildBatchDownloadTargets(chapters, lastReadChapterId, downloadStatuses),
    [chapters, downloadStatuses, lastReadChapterId],
  );
  const batchDownloadOptions: BatchDownloadOption[] = useMemo(
    () => [
      {
        chapters: batchTargets.all,
        description: t("novel.batchDownload.available", {
          count: batchTargets.all.length,
        }),
        key: "all",
        label: t("novel.batchDownload.all"),
      },
      {
        chapters: batchTargets.unread,
        description: t("novel.batchDownload.available", {
          count: batchTargets.unread.length,
        }),
        key: "unread",
        label: t("novel.batchDownload.unread"),
      },
      {
        chapters: batchTargets.next10,
        description: t("novel.batchDownload.available", {
          count: batchTargets.next10.length,
        }),
        key: "next10",
        label: t("novel.batchDownload.next10"),
      },
      {
        chapters: batchTargets.next30,
        description: t("novel.batchDownload.available", {
          count: batchTargets.next30.length,
        }),
        key: "next30",
        label: t("novel.batchDownload.next30"),
      },
    ],
    [batchTargets, t],
  );
  const statusLabel = novelStatusLabel(novel.status, t);
  const byline = [
    novel.author,
    novel.artist && novel.artist !== novel.author ? novel.artist : null,
  ].filter(Boolean).join(" · ");
  const meta = [statusLabel, sourceName].filter(Boolean).join(" · ");

  return (
    <section aria-labelledby={titleId} className="norea-novel-hero">
      <div className="norea-novel-identity">
        <div className="norea-novel-cover">
          <ConsoleCover alt={novel.name} height="auto" src={coverSource} width="100%" />
        </div>
        <div className="norea-novel-identity-text">
          <h1 className="norea-novel-title" id={titleId} ref={titleRef} title={novel.name}>
            {novel.name}
          </h1>
          {byline ? <p className="norea-novel-byline">{byline}</p> : null}
          <p className="norea-novel-meta">{meta}</p>
          {chapters.length > 0 ? (
            <p className="norea-novel-meta">
              {t("novel.percentRead", { progress: readPercent })}
            </p>
          ) : null}
          {categoryChips}
        </div>
      </div>

      <Button
        className="norea-novel-continue"
        disabled={!continueReadingChapter}
        fullWidth
        leftSection={<PlayIcon size="1.25rem" />}
        onClick={() => continueReadingChapter && onRead(continueReadingChapter)}
        size="md"
      >
        {hasHistory && continueReadingChapter
          ? t("novel.continueChapter", {
              number: formatChapterNumber(continueReadingChapter),
            })
          : t("novel.startReading")}
      </Button>

      <div className="norea-novel-actions">
        <Button
          aria-pressed={novel.inLibrary}
          leftSection={
            novel.inLibrary ? (
              <InLibraryIcon size="1.125rem" />
            ) : (
              <AddToLibraryIcon size="1.125rem" />
            )
          }
          loading={libraryBusy}
          onClick={onToggleLibrary}
          variant={novel.inLibrary ? "light" : "default"}
        >
          {novel.inLibrary ? t("novel.inLibraryAction") : t("novel.addToLibrary")}
        </Button>
        {novel.isLocal ? null : (
          <Button
            leftSection={<DownloadIcon size="1.125rem" />}
            onClick={() => setDownloadSheetOpen(true)}
            variant="default"
          >
            {t("novel.download")}
          </Button>
        )}
        {hasHistory && firstChapter ? (
          <Button
            leftSection={<FromStartIcon size="1.125rem" />}
            onClick={() => onRead(firstChapter)}
            variant="default"
          >
            {t("novel.fromStart")}
          </Button>
        ) : null}
      </div>

      <NovelSummary genres={genres} summary={novel.summary} />

      {novel.isLocal ? null : (
        <NovelDownloadSheet
          onClose={() => setDownloadSheetOpen(false)}
          onDownload={onBatchDownload}
          opened={downloadSheetOpen}
          options={batchDownloadOptions}
        />
      )}
    </section>
  );
}

function NovelSummary({
  genres,
  summary,
}: {
  genres: readonly string[];
  summary: string | null;
}) {
  const { t } = useTranslation();
  const contentId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const genresRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (expanded) return;
    const measure = () => {
      const overflows = (element: HTMLElement | null) =>
        element !== null && element.scrollHeight > element.clientHeight + 1;
      setOverflowing(overflows(textRef.current) || overflows(genresRef.current));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (textRef.current) observer.observe(textRef.current);
    if (genresRef.current) observer.observe(genresRef.current);
    return () => observer.disconnect();
  }, [expanded, genres, summary]);

  return (
    <div className="norea-novel-summary" data-expanded={expanded ? "true" : undefined}>
      <div id={contentId}>
        <p className="norea-novel-summary-text" ref={textRef}>
          {summary || t("novel.noSummary")}
        </p>
        {genres.length > 0 ? (
          <ul aria-label={t("library.tags.title")} className="norea-novel-genres" ref={genresRef}>
            {genres.map((genre) => (
              <li className="norea-novel-genre" key={genre}>
                {genre}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {overflowing || expanded ? (
        <Button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="norea-novel-summary-toggle"
          onClick={() => setExpanded((current) => !current)}
          size="compact-sm"
          variant="subtle"
        >
          {expanded ? t("novel.summaryLess") : t("common.more")}
        </Button>
      ) : null}
    </div>
  );
}

/** The header zone's shape while the novel loads. */
export function NovelHeroSkeleton() {
  return (
    <div aria-hidden="true" className="norea-novel-hero">
      <div className="norea-novel-identity">
        <div className="norea-novel-cover">
          <Skeleton className="norea-novel-cover-skeleton" radius="sm" />
        </div>
        <div className="norea-novel-identity-text">
          <Skeleton height="1.5rem" radius="sm" width="80%" />
          <Skeleton height="0.875rem" mt="xs" radius="sm" width="50%" />
          <Skeleton height="0.875rem" radius="sm" width="40%" />
        </div>
      </div>
      <Skeleton height="2.75rem" radius="sm" />
      <Skeleton height="0.875rem" radius="sm" />
      <Skeleton height="0.875rem" radius="sm" width="70%" />
    </div>
  );
}
