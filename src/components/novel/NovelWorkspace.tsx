import { Group, Loader, Text, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { pluginManager } from "../../lib/plugins/manager";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { useNovelCoverSource } from "../../lib/use-novel-cover-source";
import {
  DetailsGlyph,
  LibraryAddedGlyph,
  LibraryAddGlyph,
  PlayFromStartGlyph,
  PlayGlyph,
  PlusGlyph,
  ReaderSettingsGlyph,
  SourceGlyph,
} from "../ActionGlyphs";
import { BackIconButton } from "../BackIconButton";
import {
  ConsoleChip,
  ConsoleCover,
  ConsolePanel,
  ConsoleProgress,
} from "../ConsolePrimitives";
import {
  buildBatchDownloadTargets,
  findFirstChapter,
  findLastReadChapter,
  getNovelReadingPercent,
  splitGenres,
  type BatchDownloadOption,
} from "./novel-detail-model";
import {
  NovelActionButton,
  NovelBatchDownloadMenu,
  NovelMetadataRefreshMenu,
  NovelReadButton,
} from "./NovelActions";
const NOVEL_TITLE_FONT_SIZES = [
  "1.55rem",
  "1.42rem",
  "1.3rem",
  "1.18rem",
  "1.05rem",
] as const;

type NovelTitleFontSize = (typeof NOVEL_TITLE_FONT_SIZES)[number];

function useAutoFitNovelTitle(title: string, enabled: boolean) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [fontSize, setFontSize] = useState<NovelTitleFontSize>(
    NOVEL_TITLE_FONT_SIZES[0],
  );

  useEffect(() => {
    if (!enabled) return;
    const element = titleRef.current;
    if (!element || typeof window === "undefined") return;

    let frame = 0;

    const overflows = () =>
      element.scrollHeight > element.clientHeight + 1 ||
      element.scrollWidth > element.clientWidth + 1;

    const fitTitle = () => {
      let nextFontSize =
        NOVEL_TITLE_FONT_SIZES[NOVEL_TITLE_FONT_SIZES.length - 1];

      for (const size of NOVEL_TITLE_FONT_SIZES) {
        element.style.setProperty("--norea-novel-title-font-size", size);
        if (!overflows()) {
          nextFontSize = size;
          break;
        }
      }

      element.style.setProperty("--norea-novel-title-font-size", nextFontSize);
      setFontSize((currentFontSize) =>
        currentFontSize === nextFontSize ? currentFontSize : nextFontSize,
      );
    };

    const scheduleFit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fitTitle);
    };

    scheduleFit();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleFit);

    resizeObserver?.observe(element);
    if (element.parentElement) resizeObserver?.observe(element.parentElement);
    window.addEventListener("resize", scheduleFit);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleFit);
    };
  }, [enabled, title]);

  return {
    titleRef,
    titleStyle: {
      "--norea-novel-title-font-size": fontSize,
    } as CSSProperties,
  };
}

interface NovelWorkspaceProps {
  chapters: ChapterListRow[];
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>;
  lastReadChapterId: number | undefined;
  localChapterAdding: boolean;
  fullMetadataRefreshing: boolean;
  metadataRefreshing: boolean;
  novel: NovelDetailRecord;
  onBack: () => void;
  onAddLocalChapters: () => void;
  onBatchDownload: (chapters: ChapterListRow[]) => void;
  onEditLocalMetadata: () => void;
  onOpenReaderSettings: () => void;
  onOpenSource: () => void;
  onRead: (chapter: ChapterListRow) => void;
  onRefreshFullMetadata: () => void;
  onRefreshMetadata: () => void;
  onToggleLibrary: () => void;
  sourceName: string;
  sourceUrl: string | null;
  toggleBusy: boolean;
}

export function NovelWorkspace({
  chapters,
  downloadStatuses,
  lastReadChapterId,
  localChapterAdding,
  fullMetadataRefreshing,
  metadataRefreshing,
  novel,
  onBack,
  onAddLocalChapters,
  onBatchDownload,
  onEditLocalMetadata,
  onOpenReaderSettings,
  onOpenSource,
  onRead,
  onRefreshFullMetadata,
  onRefreshMetadata,
  onToggleLibrary,
  sourceName,
  sourceUrl,
  toggleBusy,
}: NovelWorkspaceProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isDesktopLayout = useMediaQuery("(min-width: 992px)", undefined, {
    getInitialValueInEffect: false,
  });
  const { titleRef, titleStyle } = useAutoFitNovelTitle(
    novel.name,
    isDesktopLayout,
  );
  const coverPlugin =
    novel.isLocal || novel.inLibrary
      ? null
      : pluginManager.getPlugin(novel.pluginId);
  const coverSource = useNovelCoverSource(novel, {
    allowSourceFallback: Boolean(coverPlugin),
    plugin: coverPlugin,
  });
  const genres = useMemo(() => splitGenres(novel.genres), [novel.genres]);
  const firstChapter = useMemo(() => findFirstChapter(chapters), [chapters]);
  const lastReadChapter = useMemo(
    () => findLastReadChapter(chapters, lastReadChapterId),
    [chapters, lastReadChapterId],
  );
  const readPercent = useMemo(
    () => getNovelReadingPercent(chapters),
    [chapters],
  );
  const libraryActionLabel = novel.inLibrary
    ? t("novel.removeFromLibrary")
    : t("novel.addToLibrary");
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
  const hasBatchDownloadTargets = useMemo(
    () => batchDownloadOptions.some((option) => option.chapters.length > 0),
    [batchDownloadOptions],
  );
  const renderCoverPanel = () => (
    <ConsolePanel className="norea-novel-cover-panel">
      <ConsoleCover
        alt={novel.name}
        height={204}
        src={coverSource}
        width={136}
      />
    </ConsolePanel>
  );

  const renderGenreTags = () =>
    genres.length > 0 ? (
      <div
        className="norea-novel-tags-row"
        aria-label={t("library.tags.title")}
      >
        {genres.map((genre) => (
          <span className="norea-novel-genre-chip" key={genre}>
            <ConsoleChip>{genre}</ConsoleChip>
          </span>
        ))}
      </div>
    ) : null;

  const renderActionGroup = () => (
    <div className="norea-novel-title-actions">
      {novel.isLocal ? (
        <>
          <NovelActionButton
            disabled={localChapterAdding}
            label={t("novel.local.addChapters")}
            onClick={onAddLocalChapters}
          >
            {localChapterAdding ? <Loader size={14} /> : <PlusGlyph />}
          </NovelActionButton>
          <NovelActionButton
            label={t("novel.local.editMetadata")}
            onClick={onEditLocalMetadata}
          >
            <DetailsGlyph />
          </NovelActionButton>
        </>
      ) : (
        <>
          <NovelBatchDownloadMenu
            disabled={!hasBatchDownloadTargets}
            onDownload={onBatchDownload}
            options={batchDownloadOptions}
          />
          <NovelMetadataRefreshMenu
            fullRefreshing={fullMetadataRefreshing}
            onFullRefresh={onRefreshFullMetadata}
            onRefresh={onRefreshMetadata}
            refreshing={metadataRefreshing}
          />
          {novel.inLibrary ? (
            <NovelActionButton
              label={t("novel.mergeSource")}
              onClick={() =>
                void navigate({
                  replace: true,
                  search: { sourceNovelId: novel.id },
                  to: "/novel-merge",
                })
              }
            >
              <SourceGlyph />
            </NovelActionButton>
          ) : null}
        </>
      )}
      <NovelActionButton
        label={t("novel.readerSettings")}
        onClick={onOpenReaderSettings}
      >
        <ReaderSettingsGlyph />
      </NovelActionButton>
      <NovelActionButton
        active={novel.inLibrary}
        disabled={toggleBusy}
        label={libraryActionLabel}
        onClick={onToggleLibrary}
        pressed={novel.inLibrary}
        tone={novel.inLibrary ? "success" : "accent"}
      >
        {novel.inLibrary ? <LibraryAddedGlyph /> : <LibraryAddGlyph />}
      </NovelActionButton>
      {novel.isLocal ? null : (
        <NovelActionButton
          disabled={!sourceUrl}
          label={t("novel.openSource")}
          onClick={onOpenSource}
        >
          <DetailsGlyph />
        </NovelActionButton>
      )}
    </div>
  );

  const renderInfoPanel = (isDesktop: boolean) => (
    <ConsolePanel className="norea-novel-info-panel">
      <div className="norea-novel-title-row">
        <BackIconButton className="norea-novel-icon-button" onClick={onBack} />
        <div className="norea-novel-title-copy">
          <Title
            className="norea-novel-title"
            order={1}
            ref={isDesktop ? titleRef : undefined}
            style={isDesktop ? titleStyle : undefined}
          >
            {novel.name}
          </Title>
          <Group className="norea-novel-meta-row" gap="xs" mt={6} wrap="wrap">
            {novel.author ? (
              <Text className="norea-novel-meta">
                {t("novel.author", { name: novel.author })}
              </Text>
            ) : null}
            {novel.artist && novel.artist !== novel.author ? (
              <Text className="norea-novel-meta">
                {t("novel.artist", { name: novel.artist })}
              </Text>
            ) : null}
            <Text className="norea-novel-meta">
              {t("novel.source", {
                name: sourceName,
              })}
            </Text>
          </Group>
        </div>
        {isDesktop ? renderActionGroup() : null}
      </div>

      <div className="norea-novel-status-block">
        <Group className="norea-novel-identity-strip" gap="xs" wrap="wrap">
          {novel.status ? (
            <ConsoleChip tone="accent">{novel.status}</ConsoleChip>
          ) : null}
          {novel.isLocal ? (
            <ConsoleChip>{t("common.local")}</ConsoleChip>
          ) : null}
        </Group>

        <div className="norea-novel-progress-row">
          <div className="norea-novel-progress-block">
            <div className="norea-novel-progress-line">
              <ConsoleProgress
                value={readPercent}
                status={readPercent >= 100 ? "done" : "active"}
              />
              <span>{t("novel.percentRead", { progress: readPercent })}</span>
            </div>
            <div className="norea-novel-read-actions">
              <NovelReadButton
                disabled={!lastReadChapter}
                label={t("novel.continueReading")}
                onClick={() => lastReadChapter && onRead(lastReadChapter)}
                tone="accent"
              >
                <PlayGlyph />
              </NovelReadButton>
              <NovelReadButton
                disabled={!firstChapter}
                label={t("novel.startReading")}
                onClick={() => firstChapter && onRead(firstChapter)}
              >
                <PlayFromStartGlyph />
              </NovelReadButton>
            </div>
          </div>
          {isDesktop ? null : renderActionGroup()}
        </div>
      </div>
    </ConsolePanel>
  );

  const renderSummaryPanel = () => (
    <ConsolePanel
      className="norea-novel-summary-panel"
      title={t("common.summary")}
    >
      <div className="norea-novel-summary-content">
        {novel.summary ? (
          <Text className="norea-novel-summary-text">{novel.summary}</Text>
        ) : (
          <Text className="norea-novel-empty-copy">{t("novel.noSummary")}</Text>
        )}
        {renderGenreTags()}
      </div>
    </ConsolePanel>
  );

  return (
    <div className="norea-novel-workspace">
      {isDesktopLayout ? (
        <div className="norea-novel-hero-desktop">
          {renderCoverPanel()}
          {renderInfoPanel(true)}
          {renderSummaryPanel()}
        </div>
      ) : (
        <div className="norea-novel-hero-mobile">
          {renderInfoPanel(false)}
          <div className="norea-novel-cover-summary-card">
            {renderCoverPanel()}
            {renderSummaryPanel()}
          </div>
        </div>
      )}
    </div>
  );
}
