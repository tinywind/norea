import { Button, Loader, Skeleton } from "@mantine/core";
import {
  useId,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import type { DownloadGoalOfflineState } from "../../lib/download-goals/goal-offline-state";
import { pluginManager } from "../../lib/plugins/manager";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { useNovelCoverSource } from "../../lib/use-novel-cover-source";
import { ChapterCountBadges, CoverReadingProgress } from "../ChapterCountBadges";
import { ConsoleCover } from "../ConsolePrimitives";
import {
  AddToLibraryIcon,
  DownloadIcon,
  FromStartIcon,
  PlayIcon,
} from "../ui/icons";
import {
  type getNovelChapterStats,
  findContinueReadingTarget,
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
  /** Assigned categories and their edit action, shown under the title. */
  categoryChips?: ReactNode;
  chapters: ChapterListRow[];
  chapterStats: ReturnType<typeof getNovelChapterStats> | undefined;
  /** Shown over the cover while the source is checked for new chapters. */
  checkingNewChapters?: boolean;
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>;
  lastReadChapterId: number | undefined;
  libraryBusy: boolean;
  novel: NovelDetailRecord;
  /** Offline state of a novel with a download goal in effect, as its library card shows it. */
  offlineState?: DownloadGoalOfflineState;
  onRead: (chapter: ChapterListRow, options?: { fromStart?: boolean }) => void;
  onSelectGenre: (genre: string) => void;
  /** Starts chapter selection for a one-time download. */
  onSelectChapters: () => void;
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
  hasServerSource = false,
  categoryChips,
  chapters,
  chapterStats,
  checkingNewChapters = false,
  downloadStatuses,
  lastReadChapterId,
  libraryBusy,
  novel,
  offlineState,
  onRead,
  onSelectGenre,
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
  const continueReadingTarget = useMemo(
    () => findContinueReadingTarget(chapters, lastReadChapterId),
    [chapters, lastReadChapterId],
  );
  const hasHistory = hasReadingHistory(chapters, lastReadChapterId);
  const continuesAtStart = continueReadingTarget?.chapter.id === firstChapter?.id &&
    (continueReadingTarget?.fromStart || firstChapter?.progress === 0);
  const statusLabel = novelStatusLabel(novel.status, t, novel.statusOverride);
  const byline = [
    novel.author,
    novel.artist && novel.artist !== novel.author ? novel.artist : null,
  ].filter(Boolean).join(" · ");

  return (
    <section aria-labelledby={titleId} className="norea-novel-hero">
      <div className="norea-novel-identity">
        <div className="norea-novel-cover">
          <ConsoleCover alt={novel.name} height="auto" src={coverSource} width="100%" />
          {chapterStats ? <CoverReadingProgress progress={chapterStats.readingProgress} /> : null}
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
          <div className="norea-novel-info-row">
            <div className="norea-novel-metadata">
              {byline ? <p className="norea-novel-byline" title={byline}>{byline}</p> : null}
              {sourceName ? <p className="norea-novel-meta norea-novel-source" title={sourceName}>{sourceName}</p> : null}
              {statusLabel ? <p className="norea-novel-meta norea-novel-status">{statusLabel}</p> : null}
            </div>
            <div className="norea-novel-category-slot">{categoryChips}</div>
            <div className="norea-novel-reading-status">
              {chapterStats ? (
                <ChapterCountBadges downloaded={chapterStats.downloaded} unread={chapterStats.unread} offlineState={offlineState} />
              ) : null}
            </div>
          </div>
          <NovelSummary genres={genres} onSelectGenre={onSelectGenre} summary={novel.summary} />
        </div>
      </div>

      <Button
        className="norea-novel-continue"
        disabled={!continueReadingTarget}
        fullWidth
        leftSection={<PlayIcon size="1.25rem" />}
        onClick={() =>
          continueReadingTarget &&
          onRead(
            continueReadingTarget.chapter,
            continueReadingTarget.fromStart ? { fromStart: true } : undefined,
          )
        }
        size="md"
      >
        {continueReadingTarget
          ? hasHistory
            ? t("novel.continueChapter", {
                number: formatChapterNumber(continueReadingTarget.chapter),
              })
            : t("novel.startReading")
          : hasHistory
            ? t("novel.nothingToContinue")
            : t("novel.startReading")}
      </Button>

      <div className="norea-novel-actions">
        {novel.inLibrary ? null : (
          <Button
            leftSection={<AddToLibraryIcon size="1.125rem" />}
            loading={libraryBusy}
            onClick={onToggleLibrary}
            variant="subtle"
          >
            {t("novel.addToLibrary")}
          </Button>
        )}
        {novel.isLocal ? null : (
          <Button
            leftSection={<DownloadIcon size="1.125rem" />}
            onClick={() => setDownloadSheetOpen(true)}
            variant="subtle"
          >
            {t("novel.download")}
          </Button>
        )}
        {hasHistory && firstChapter && !continuesAtStart ? (
          <Button
            leftSection={<FromStartIcon size="1.125rem" />}
            onClick={() => onRead(firstChapter, { fromStart: true })}
            variant="subtle"
          >
            {t("novel.fromStart")}
          </Button>
        ) : null}
      </div>

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
  onSelectGenre,
  summary,
}: {
  genres: readonly string[];
  onSelectGenre: (genre: string) => void;
  summary: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div aria-label={t("library.localNovel.summary")} className="norea-novel-summary" role="region" tabIndex={0}>
      <p className="norea-novel-summary-text">{summary || t("novel.noSummary")}</p>
      {genres.length > 0 ? (
        <div className="norea-novel-tag-group">
          <p className="norea-novel-tag-heading">{t("novel.libraryTags")}</p>
          <ul aria-label={t("library.tags.title")} className="norea-novel-genres">
            {genres.map(genre => (
              <li key={genre}>
                <button className="norea-novel-genre" onClick={() => onSelectGenre(genre)} type="button">
                  {genre}
                </button>
              </li>
            ))}
          </ul>
        </div>
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
      <Skeleton height="3rem" radius="sm" />
      <Skeleton height="0.875rem" radius="sm" />
      <Skeleton height="0.875rem" radius="sm" width="70%" />
    </div>
  );
}
