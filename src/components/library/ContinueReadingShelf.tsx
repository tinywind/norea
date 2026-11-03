import { RingProgress, VisuallyHidden } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import {
  CONTINUE_READING_LIMIT,
  getContinueReadingTarget,
  listContinueReading,
  type ContinueReadingEntry,
} from "../../db/queries/continue-reading";
import { useTranslation } from "../../i18n";
import { pluginManager } from "../../lib/plugins/manager";
import { novelLibraryQueryKey } from "../../lib/reader-query-invalidation";
import { useNovelCoverSource } from "../../lib/use-novel-cover-source";
import { useLibraryStore } from "../../store/library";
import { ConsoleCover } from "../ConsolePrimitives";
import { ChevronDownIcon, ChevronRightIcon } from "../ui/icons";

/** Under the library key, so reading progress and library changes refresh it. */
export const continueReadingQueryKey = [
  ...novelLibraryQueryKey,
  "continue-reading",
  CONTINUE_READING_LIMIT,
] as const;

/** The shelf belongs to the unfiltered All view only. */
export function isContinueReadingShelfVisible(view: {
  enabled: boolean;
  filterActive: boolean;
  search: string;
  selectedCategoryId: number | null;
  selectionMode: boolean;
}): boolean {
  return (
    view.enabled &&
    !view.selectionMode &&
    view.selectedCategoryId === null &&
    !view.filterActive &&
    view.search.trim() === ""
  );
}

function ContinueReadingCard({
  entry,
  onOpen,
}: {
  entry: ContinueReadingEntry;
  onOpen: (chapterId: number) => void;
}) {
  const { t } = useTranslation();
  const plugin = entry.novelIsLocal ? null : pluginManager.getPlugin(entry.pluginId);
  const coverSource = useNovelCoverSource(
    {
      cover: entry.novelCover,
      id: entry.novelId,
      isLocal: entry.novelIsLocal,
      name: entry.novelName,
      path: entry.novelPath,
      pluginId: entry.pluginId,
    },
    { allowSourceFallback: Boolean(plugin), plugin },
  );
  const target = getContinueReadingTarget(entry);
  const progress = Math.max(0, Math.min(100, Math.round(entry.progress)));

  return (
    <button
      className="norea-continue-card norea-state-layer"
      onClick={() => onOpen(target.chapterId)}
      type="button"
    >
      <span aria-hidden="true" className="norea-continue-card-cover">
        <ConsoleCover alt={entry.novelName} height="auto" src={coverSource} width="100%" />
      </span>
      <VisuallyHidden>{entry.novelName}</VisuallyHidden>
      <span className="norea-continue-card-meta">
        <span className="norea-continue-card-chapter">
          {t("history.chapterNumber", { number: target.position })}
        </span>
        {target.next ? (
          <span className="norea-continue-card-next">{t("library.continueReading.next")}</span>
        ) : (
          <>
            <RingProgress
              aria-hidden="true"
              rootColor="var(--norea-color-rule)"
              sections={[{ color: "var(--norea-color-accent)", value: progress }]}
              size={22}
              thickness={3}
            />
            <VisuallyHidden>{t("library.grid.readPercent", { progress })}</VisuallyHidden>
          </>
        )}
      </span>
    </button>
  );
}

interface ContinueReadingShelfProps {
  active: boolean;
  onOpen: (chapterId: number) => void;
}

/**
 * RD1: up to six library novels with a resume target, newest read first.
 * Renders nothing until there is something to continue.
 */
export function ContinueReadingShelf({ active, onOpen }: ContinueReadingShelfProps) {
  const { t } = useTranslation();
  const listId = useId();
  const collapsed = useLibraryStore((s) => s.continueReadingCollapsed);
  const setCollapsed = useLibraryStore((s) => s.setContinueReadingCollapsed);
  const entries = useQuery({
    enabled: active,
    meta: { errorPresentation: "inline" },
    queryKey: continueReadingQueryKey,
    queryFn: () => listContinueReading(CONTINUE_READING_LIMIT),
  });
  if (!entries.data?.length) return null;
  const ToggleIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;

  return (
    <section aria-labelledby={`${listId}-title`} className="norea-continue-shelf">
      <h2 className="norea-continue-shelf-heading">
        <button
          aria-controls={collapsed ? undefined : listId}
          aria-expanded={!collapsed}
          className="norea-continue-shelf-toggle norea-state-layer"
          id={`${listId}-title`}
          onClick={() => setCollapsed(!collapsed)}
          type="button"
        >
          <span>{t("library.continueReading.title")}</span>
          <ToggleIcon aria-hidden="true" size="1.125rem" />
        </button>
      </h2>
      {collapsed ? null : (
        <ul className="norea-continue-shelf-list" id={listId}>
          {entries.data.map((entry) => (
            <li key={entry.novelId}>
              <ContinueReadingCard entry={entry} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
