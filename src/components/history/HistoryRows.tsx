import { Loader, Skeleton } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import {
  getAdjacentChapter,
  type ChapterListRow,
  type RecentlyReadEntry,
} from "../../db/queries/chapter";
import { formatRelativeTimeForLocale, useTranslation } from "../../i18n";
import { pluginManager } from "../../lib/plugins/manager";
import { useNovelCoverSource } from "../../lib/use-novel-cover-source";
import { ConsoleCover } from "../ConsolePrimitives";
import { formatChapterNumber } from "../novel/novel-detail-model";
import { InfoIcon, TrashIcon } from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { OverflowMenu } from "../ui/OverflowMenu";
import { IconButton } from "../IconButton";

export const FINISHED_PROGRESS = 100;
const SKELETON_ROWS = 6;

/** The number the row shows, or null when the source stored 0, which plugins use for an unknown number. */
function shownChapterNumber(entry: Pick<RecentlyReadEntry, "chapterName" | "chapterNumber" | "displayChapterNumber" | "position">): string | null {
  const number = formatChapterNumber(entry);
  return Number(number) === 0 ? null : number;
}

function HistoryCover({ entry }: { entry: RecentlyReadEntry }) {
  const plugin =
    entry.novelIsLocal || entry.novelInLibrary
      ? null
      : pluginManager.getPlugin(entry.pluginId);
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

  return (
    <span aria-hidden="true">
      <ConsoleCover alt={entry.novelName} height={66} src={coverSource} width={44} />
    </span>
  );
}

interface HistoryRowProps {
  entry: RecentlyReadEntry;
  /**
   * Receives the next chapter when the last read one is finished: the row,
   * `null` when none is indexed, or `undefined` while it is still loading.
   */
  onContinue: (nextChapter: ChapterListRow | null | undefined) => void;
  onOpenNovel: () => void;
  onRemove: () => void;
  removing: boolean;
}

/**
 * One novel's latest read chapter. A tap continues reading: an unfinished
 * chapter resumes, a finished one opens the next chapter when it is indexed.
 */
export function HistoryRow({
  entry,
  onContinue,
  onOpenNovel,
  onRemove,
  removing,
}: HistoryRowProps) {
  const { locale, t } = useTranslation();
  const progress = Math.max(0, Math.min(100, Math.round(entry.progress)));
  const finished = progress >= FINISHED_PROGRESS;
  const nextChapter = useQuery({
    enabled: finished,
    queryKey: ["chapter", "history", "next", entry.chapterId] as const,
    queryFn: () => getAdjacentChapter(entry.novelId, entry.position, 1),
  });
  const readAt = formatRelativeTimeForLocale(locale, entry.readAt);
  const chapterNumber = shownChapterNumber(entry);
  const meta = [
    chapterNumber ? t("history.chapterNumber", { number: chapterNumber }) : entry.chapterName,
    finished ? t("common.finished") : progress > 0 ? `${progress}%` : null,
    readAt,
  ].filter(Boolean).join(" · ");

  return (
    <div className="norea-history-row" data-removing={removing ? "true" : undefined}>
      <ListRow
        className="norea-history-row-open"
        leading={<HistoryCover entry={entry} />}
        onClick={() => onContinue(finished ? nextChapter.data : undefined)}
        subtitle={
          <>
            <span className="norea-history-row-meta">
              {finished && nextChapter.data
                ? `${t("history.nextChapter", { number: formatChapterNumber(nextChapter.data) })} · ${readAt}`
                : meta}
            </span>
            <span aria-hidden="true" className="norea-history-progress">
              <span
                className="norea-history-progress-bar"
                data-status={finished ? "finished" : undefined}
                style={{ "--norea-history-progress": `${progress}%` } as CSSProperties}
              />
            </span>
          </>
        }
        title={entry.novelName}
      />
      <div className="norea-history-row-trailing">
        {removing ? (
          <span
            aria-label={t("history.removing")}
            className="norea-history-row-busy"
            role="status"
          >
            <Loader aria-hidden="true" size="xs" />
          </span>
        ) : (
          <>
            <IconButton label={t("history.novelDetails")} onClick={onOpenNovel} size="lg">
              <InfoIcon />
            </IconButton>
            <OverflowMenu
              items={[
                {
                  danger: true,
                  icon: TrashIcon,
                  label: t("history.remove"),
                  onClick: onRemove,
                },
              ]}
              label={t("history.rowMore", { name: entry.novelName })}
            />
          </>
        )}
      </div>
    </div>
  );
}

export function HistoryRowsSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div className="norea-history-row norea-history-row-skeleton" key={index}>
          <Skeleton height="4.125rem" radius="sm" width="2.75rem" />
          <div className="norea-history-row-skeleton-text">
            <Skeleton height="0.875rem" radius="sm" width="45%" />
            <Skeleton height="0.75rem" radius="sm" width="60%" />
            <Skeleton height="0.25rem" radius="sm" width="50%" />
          </div>
        </div>
      ))}
    </div>
  );
}
