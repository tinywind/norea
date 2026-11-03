import { Skeleton, VisuallyHidden } from "@mantine/core";
import { memo, type CSSProperties, type MouseEvent } from "react";
import type { LibraryNovel } from "../db/queries/novel";
import { useTranslation, type TranslationKey } from "../i18n";
import { useLongPress } from "../lib/use-long-press";
import { useNovelCoverSource } from "../lib/use-novel-cover-source";
import type { LibraryDisplayMode } from "../store/library";
import { ConsoleCover } from "./ConsolePrimitives";
import { CheckIcon, DownloadedIcon, UnreadIcon } from "./ui/icons";
import { ListRow } from "./ui/ListRow";

const LONG_PRESS_MS = 500;
const SKELETON_ITEMS = 12;

interface LibraryGridProps {
  novels: readonly LibraryNovel[];
  displayMode: LibraryDisplayMode;
  novelsPerRow: number;
  showDownloadBadges: boolean;
  showUnreadBadges: boolean;
  showNumberBadges: boolean;
  selectedIds?: ReadonlySet<number>;
  /** Taps toggle selection and every item shows its check state. */
  selectionMode?: boolean;
  onActivate?: (id: number) => void;
  onLongPress?: (id: number) => void;
}

export function LibraryGrid({
  novels,
  displayMode,
  novelsPerRow,
  showDownloadBadges,
  showUnreadBadges,
  showNumberBadges,
  selectedIds,
  selectionMode = false,
  onActivate,
  onLongPress,
}: LibraryGridProps) {
  const itemProps = (novel: LibraryNovel, index: number): LibraryItemProps => ({
    index,
    novel,
    onActivate,
    onLongPress,
    selected: selectedIds?.has(novel.id) ?? false,
    selectionMode,
    showDownloadBadges,
    showNumberBadges,
    showUnreadBadges,
  });

  if (displayMode === "list") {
    return (
      <ul className="norea-library-list">
        {novels.map((novel, index) => (
          <li key={novel.id}>
            <LibraryListRow {...itemProps(novel, index)} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul
      className="norea-library-grid"
      data-mode={displayMode}
      style={
        {
          "--norea-library-grid-columns": novelsPerRow,
        } as CSSProperties
      }
    >
      {novels.map((novel, index) => (
        <li className="norea-library-grid-item" key={novel.id}>
          <LibraryCard displayMode={displayMode} {...itemProps(novel, index)} />
          {selectionMode || !onLongPress ? null : (
            <SelectToggle name={novel.name} onSelect={() => onLongPress(novel.id)} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Placeholder items in the current display mode while the library loads. */
export function LibraryGridSkeleton({
  displayMode,
  label,
  novelsPerRow,
}: {
  displayMode: LibraryDisplayMode;
  label: string;
  novelsPerRow: number;
}) {
  const items = Array.from({ length: SKELETON_ITEMS }, (_, index) => index);
  return (
    <div aria-busy="true" aria-label={label} role="status">
      {displayMode === "list" ? (
        <ul aria-hidden="true" className="norea-library-list">
          {items.map((index) => (
            <li className="norea-library-skeleton-row" key={index}>
              <Skeleton height="3.75rem" radius="sm" width="2.5rem" />
              <span className="norea-library-skeleton-lines">
                <Skeleton height="0.75rem" radius="sm" width="60%" />
                <Skeleton height="0.625rem" radius="sm" width="35%" />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul
          aria-hidden="true"
          className="norea-library-grid"
          data-mode={displayMode}
          style={{ "--norea-library-grid-columns": novelsPerRow } as CSSProperties}
        >
          {items.map((index) => (
            <li className="norea-library-skeleton-card" key={index}>
              <Skeleton className="norea-library-skeleton-cover" radius="sm" />
              {displayMode === "comfortable" ? (
                <>
                  <Skeleton height="0.75rem" radius="sm" width="85%" />
                  <Skeleton height="0.625rem" radius="sm" width="50%" />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface LibraryItemProps {
  index: number;
  novel: LibraryNovel;
  onActivate?: (id: number) => void;
  onLongPress?: (id: number) => void;
  selected: boolean;
  selectionMode: boolean;
  showDownloadBadges: boolean;
  showNumberBadges: boolean;
  showUnreadBadges: boolean;
}

/**
 * Selects a card with a pointer that can hover. It stays out of the tab
 * order: keyboard users enter selection mode from the overflow menu.
 */
function SelectToggle({ name, onSelect }: { name: string; onSelect: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      aria-label={t("library.selection.selectNamed", { name })}
      className="norea-library-select-toggle norea-state-layer"
      onClick={onSelect}
      tabIndex={-1}
      type="button"
    >
      <CheckIcon size="1rem" />
    </button>
  );
}

function SelectionCheck({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="norea-library-check"
      data-checked={selected ? "true" : undefined}
    >
      {selected ? <CheckIcon size="1rem" /> : null}
    </span>
  );
}

/** Click and long-press handlers for a library item button. */
function useLibraryItemPress(
  novelId: number,
  onActivate?: (id: number) => void,
  onLongPress?: (id: number) => void,
) {
  const longPress = useLongPress(
    onLongPress ? () => onLongPress(novelId) : undefined,
    LONG_PRESS_MS,
  );

  return {
    ...longPress.handlers,
    "data-pressing": longPress.pressing ? "true" : undefined,
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (longPress.consumeFired()) {
        event.preventDefault();
        return;
      }
      onActivate?.(novelId);
    },
  };
}

const LibraryCard = memo(function LibraryCard({
  displayMode,
  index,
  novel,
  onActivate,
  onLongPress,
  selected,
  selectionMode,
  showDownloadBadges,
  showNumberBadges,
  showUnreadBadges,
}: LibraryItemProps & { displayMode: LibraryDisplayMode }) {
  const { t } = useTranslation();
  const press = useLibraryItemPress(novel.id, onActivate, onLongPress);
  const coverSource = useNovelCoverSource(novel, { allowSourceFallback: true });
  const progress = getReadingPercent(novel);
  const coverOnly = displayMode === "cover-only";
  const author = getCreatorLabel(novel, t);

  return (
    <button
      aria-pressed={selectionMode ? selected : undefined}
      className="norea-library-card norea-state-layer"
      data-selected={selected ? "true" : undefined}
      type="button"
      {...press}
    >
      <span className="norea-library-card-cover">
        <span aria-hidden={coverOnly ? undefined : true}>
          <ConsoleCover alt={novel.name} height="auto" src={coverSource} width="100%" />
        </span>
        <LibraryBadges
          index={index}
          novel={novel}
          showDownloadBadges={showDownloadBadges}
          showNumberBadges={showNumberBadges}
          showUnreadBadges={showUnreadBadges}
        />
        {progress > 0 ? (
          <span
            aria-hidden="true"
            className="norea-library-card-progress"
            style={{ "--norea-library-progress": `${progress}%` } as CSSProperties}
          />
        ) : null}
        {selectionMode ? <SelectionCheck selected={selected} /> : null}
        {displayMode === "compact" ? (
          <span className="norea-library-card-overlay">
            <span className="norea-library-card-title">{novel.name}</span>
          </span>
        ) : null}
      </span>
      {displayMode === "comfortable" ? (
        <span className="norea-library-card-text">
          <span className="norea-library-card-title">{novel.name}</span>
          <span className="norea-library-card-author">{author}</span>
        </span>
      ) : null}
      {progress > 0 ? (
        <VisuallyHidden>{t("library.grid.readPercent", { progress })}</VisuallyHidden>
      ) : null}
    </button>
  );
});

const LibraryListRow = memo(function LibraryListRow({
  index,
  novel,
  onActivate,
  onLongPress,
  selected,
  selectionMode,
  showDownloadBadges,
  showNumberBadges,
  showUnreadBadges,
}: LibraryItemProps) {
  const { t } = useTranslation();
  const press = useLibraryItemPress(novel.id, onActivate, onLongPress);
  const coverSource = useNovelCoverSource(novel, { allowSourceFallback: true });
  const progress = getReadingPercent(novel);

  return (
    <ListRow
      aria-pressed={selectionMode ? selected : undefined}
      className="norea-library-row"
      leading={
        <span aria-hidden="true" className="norea-library-row-cover">
          <ConsoleCover alt={novel.name} height={60} src={coverSource} width={40} />
          {selectionMode ? <SelectionCheck selected={selected} /> : null}
        </span>
      }
      selected={selected}
      subtitle={
        <>
          <span className="norea-library-row-author">{getCreatorLabel(novel, t)}</span>
          <span
            aria-hidden="true"
            className="norea-library-row-progress"
            style={{ "--norea-library-progress": `${progress}%` } as CSSProperties}
          />
          <VisuallyHidden>{t("library.grid.readPercent", { progress })}</VisuallyHidden>
        </>
      }
      title={novel.name}
      trailing={
        <LibraryBadges
          index={index}
          novel={novel}
          showDownloadBadges={showDownloadBadges}
          showNumberBadges={showNumberBadges}
          showUnreadBadges={showUnreadBadges}
        />
      }
      {...press}
    />
  );
});

function LibraryBadges({
  index,
  novel,
  showDownloadBadges,
  showNumberBadges,
  showUnreadBadges,
}: Omit<LibraryItemProps, "onActivate" | "onLongPress" | "selected" | "selectionMode">) {
  const { t } = useTranslation();
  const unread = showUnreadBadges && novel.chaptersUnread > 0;
  const downloaded = showDownloadBadges && novel.chaptersDownloaded > 0;
  if (!unread && !downloaded && !showNumberBadges) return null;
  const downloadedLabel = t("library.grid.downloadedBadge", { count: novel.chaptersDownloaded });
  const unreadLabel = t("library.grid.unreadBadge", { count: novel.chaptersUnread });

  return (
    <span className="norea-library-badges">
      {showNumberBadges ? (
        <span aria-hidden="true" className="norea-library-badge" data-kind="number">
          {index + 1}
        </span>
      ) : null}
      {downloaded ? (
        <span className="norea-library-badge" data-kind="downloaded" title={downloadedLabel}>
          <DownloadedIcon size="0.875rem" />
          <span aria-hidden="true">{novel.chaptersDownloaded}</span>
          <VisuallyHidden>{downloadedLabel}</VisuallyHidden>
        </span>
      ) : null}
      {unread ? (
        <span className="norea-library-badge" data-kind="unread" title={unreadLabel}>
          <UnreadIcon size="0.875rem" />
          <span aria-hidden="true">{novel.chaptersUnread}</span>
          <VisuallyHidden>{unreadLabel}</VisuallyHidden>
        </span>
      ) : null}
    </span>
  );
}

function getReadingPercent(novel: LibraryNovel) {
  return Math.max(0, Math.min(100, Math.round(novel.readingProgress)));
}

function getCreatorLabel(
  novel: LibraryNovel,
  t: (key: TranslationKey) => string,
) {
  return (
    novel.author?.trim() ||
    (novel.isLocal ? t("library.grid.local") : (novel.pluginName ?? novel.pluginId))
  );
}
