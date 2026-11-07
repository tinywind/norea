import { Button, Loader, Skeleton } from "@mantine/core";
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
import { useTranslation, type TranslationKey } from "../../i18n";
import type { DownloadGoalOfflineState } from "../../lib/download-goals/goal-offline-state";
import { pluginManager } from "../../lib/plugins/manager";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { useNovelCoverSource } from "../../lib/use-novel-cover-source";
import { ConsoleCover } from "../ConsolePrimitives";
import {
  AddToLibraryIcon,
  DownloadedIcon,
  DownloadIcon,
  FromStartIcon,
  InLibraryIcon,
  PlayIcon,
  WarningIcon,
} from "../ui/icons";
import {
  countReadChapters,
  findContinueReadingChapter,
  findFirstChapter,
  formatChapterNumber,
  hasReadingHistory,
  novelStatusLabel,
  splitGenres,
} from "./novel-detail-model";
import { NovelDownloadSheet } from "./NovelActions";

interface NovelWorkspaceProps {
  allowSourceAccess: boolean;
  hasServerSource?: boolean;
  /** Category chips, shown under the title while the novel is in the library. */
  categoryChips?: ReactNode;
  chapters: ChapterListRow[];
  /** Shown over the cover while the source is checked for new chapters. */
  checkingNewChapters?: boolean;
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>;
  lastReadChapterId: number | undefined;
  libraryBusy: boolean;
  novel: NovelDetailRecord;
  /** Offline state of a novel with a download goal in effect, as its library card shows it. */
  offlineState?: DownloadGoalOfflineState;
  onRead: (chapter: ChapterListRow) => void;
  /** Starts chapter selection for a one-time download. */
  onSelectChapters: () => void;
  onToggleLibrary: () => void;
  sourceName: string;
  titleRef?: Ref<HTMLHeadingElement>;
}

const OFFLINE_STATE_LABELS: Record<DownloadGoalOfflineState, TranslationKey> = {
  ready: "novel.offline.ready",
  downloading: "novel.offline.downloading",
  attention: "novel.offline.attention",
};

const OFFLINE_STATE_ICONS = { ready: DownloadedIcon, downloading: DownloadIcon, attention: WarningIcon };

/**
 * The novel's header zone: cover, identity, the Continue action, the library,
 * download and from-start actions, and the clamped summary with genres.
 */
export function NovelWorkspace({
  allowSourceAccess,
  hasServerSource = false,
  categoryChips,
  chapters,
  checkingNewChapters = false,
  downloadStatuses,
  lastReadChapterId,
  libraryBusy,
  novel,
  offlineState,
  onRead,
  onSelectChapters,
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
  const readCount = useMemo(() => countReadChapters(chapters), [chapters]);
  const statusLabel = novelStatusLabel(novel.status, t);
  const byline = [
    novel.author,
    novel.artist && novel.artist !== novel.author ? novel.artist : null,
  ].filter(Boolean).join(" · ");
  const meta = [statusLabel, sourceName].filter(Boolean).join(" · ");
  const OfflineIcon = offlineState ? OFFLINE_STATE_ICONS[offlineState] : null;

  return (
    <section aria-labelledby={titleId} className="norea-novel-hero">
      <div className="norea-novel-identity">
        <div className="norea-novel-cover">
          <ConsoleCover alt={novel.name} height="auto" src={coverSource} width="100%" />
          {checkingNewChapters ? (
            <p className="norea-novel-cover-status" role="status">
              <Loader aria-hidden="true" color="currentColor" size={14} />
              {t("novel.checkingNewChapters")}
            </p>
          ) : null}
        </div>
        <div className="norea-novel-identity-text">
          <h1 className="norea-novel-title" id={titleId} ref={titleRef} title={novel.name}>
            {novel.name}
          </h1>
          {byline ? <p className="norea-novel-byline">{byline}</p> : null}
          <p className="norea-novel-meta">{meta}</p>
          {readCount > 0 ? (
            <p className="norea-novel-meta">
              {t("novel.chaptersRead", { read: readCount, total: chapters.length })}
            </p>
          ) : null}
          {offlineState && OfflineIcon ? (
            <p className="norea-novel-meta norea-novel-offline" data-goal-state={offlineState}>
              <OfflineIcon size="1rem" />
              {t(OFFLINE_STATE_LABELS[offlineState])}
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
          chapters={chapters}
          downloadStatuses={downloadStatuses}
          hasServerSource={hasServerSource}
          novel={novel}
          onClose={() => setDownloadSheetOpen(false)}
          onSelectChapters={onSelectChapters}
          opened={downloadSheetOpen}
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
