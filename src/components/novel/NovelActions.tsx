import { Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { getNovelDownloadGoal, type NovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation, type TranslationKey } from "../../i18n";
import { estimateNovelDownloadMs, novelDownloadRoute } from "../../lib/download-goals/download-eta";
import {
  getDownloadGoalPauseSnapshot,
  setDownloadGoal,
  subscribeDownloadGoalPause,
} from "../../lib/download-goals/goal-service";
import { describeDownloadGoalProgress, formatDownloadEta } from "../../lib/download-goals/goal-status";
import { effectiveDownloadGoal, goalTargetChapters, resolveGoalTargets } from "../../lib/download-goals/goal-targets";
import { describeError } from "../../lib/errors";
import { DEFAULT_CHAPTER_SORT_LABEL_KEYS } from "../../lib/library-settings-options";
import { pluginManager } from "../../lib/plugins/manager";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { useTaskSnapshot } from "../../lib/tasks/hooks";
import { useBrowseStore } from "../../store/browse";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { type DefaultChapterSort } from "../../store/library";
import { DownloadGoalChoices, DownloadGoalSection, sameDownloadGoal } from "../DownloadGoalChoices";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";
import { StateView } from "../AppFrame";
import { BRIEF_TOAST_AUTO_CLOSE_MS } from "../ui/AppToasts";
import { IconButton } from "../IconButton";
import { ChevronRightIcon, SelectIcon, SortIcon } from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

export const novelDownloadGoalQueryKey = (novelId: number) => ["download-goal", novelId] as const;

interface NovelDownloadGoalSheetProps {
  chapters: readonly ChapterListRow[];
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>;
  lastReadChapterId: number | undefined;
  novel: NovelDetailRecord;
  onClose: () => void;
  /** The one-time "Choose chapters" action: hands over to chapter selection. */
  onSelectChapters: () => void;
  opened: boolean;
}

/**
 * The novel's download sheet: the current download state, the automatic
 * download goal as one choice, and one-time download actions apart from it.
 */
export function NovelDownloadGoalSheet({ onClose, opened, ...props }: NovelDownloadGoalSheetProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveSheet onClose={onClose} opened={opened} title={t("novel.download")}>
      {opened ? <NovelDownloadGoalChoices onClose={onClose} {...props} /> : null}
    </ResponsiveSheet>
  );
}

const CHOSEN_GOAL_KEYS: Record<NovelDownloadGoal["kind"], TranslationKey> = {
  none: "downloadGoals.chosen.none",
  keep_ahead: "downloadGoals.chosen.keepAhead",
  all_remaining: "downloadGoals.chosen.allRemaining",
  entire: "downloadGoals.chosen.entire",
};

type NovelDownloadGoalChoiceOptions = Pick<
  NovelDownloadGoalSheetProps,
  "chapters" | "downloadStatuses" | "lastReadChapterId" | "novel" | "onClose"
>;

/**
 * Writes the novel's download goal choice. A committed choice closes the sheet
 * with a brief toast naming what was set and how many chapters it queues; the
 * active choice only closes it; a failed write keeps it open with the error.
 */
export function useNovelDownloadGoalChoice({
  chapters,
  downloadStatuses,
  lastReadChapterId,
  novel,
  onClose,
}: NovelDownloadGoalChoiceOptions) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const defaultKeepAhead = useDownloadGoalSettingsStore((state) => state.defaultKeepAhead);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const chosenMessage = (next: NovelDownloadGoal | null) => {
    const effective = effectiveDownloadGoal(next, novel, defaultKeepAhead, Math.floor(Date.now() / 1000)).goal;
    const chosen = next === null
      ? defaultKeepAhead > 0
        ? t("downloadGoals.chosen.default", { count: defaultKeepAhead })
        : t("downloadGoals.chosen.defaultOff")
      : t(CHOSEN_GOAL_KEYS[next.kind], next.kind === "keep_ahead" ? { count: next.count } : undefined);
    if (!effective) return chosen;
    const queued = resolveGoalTargets(effective, chapters, lastReadChapterId, (chapter) => {
      const kind = downloadStatuses.get(chapter.id)?.kind;
      return kind === "queued" || kind === "running";
    }, () => false).pending.length;
    return `${chosen} · ${queued > 0 ? t("downloadGoals.chosen.queued", { count: queued }) : t("downloadGoals.chosen.ready")}`;
  };

  const choose = async (next: NovelDownloadGoal | null, ownGoal: NovelDownloadGoal | null) => {
    if (saving) return;
    if (sameDownloadGoal(next, ownGoal)) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setDownloadGoal(novel.id, next);
      queryClient.setQueryData(
        novelDownloadGoalQueryKey(novel.id),
        next ? { novelId: novel.id, goal: next, updatedAt: Date.now() } : null,
      );
      void queryClient.invalidateQueries({ queryKey: DOWNLOAD_GOALS_QUERY_KEY });
      onClose();
      notifications.show({ autoClose: BRIEF_TOAST_AUTO_CLOSE_MS, color: "ok", message: chosenMessage(next) });
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return { choose, error, saving };
}

function NovelDownloadGoalChoices({
  chapters,
  downloadStatuses,
  lastReadChapterId,
  novel,
  onClose,
  onSelectChapters,
}: Omit<NovelDownloadGoalSheetProps, "opened">) {
  const { t } = useTranslation();
  const queryKey = novelDownloadGoalQueryKey(novel.id);
  const ownGoal = useQuery({ queryKey, queryFn: () => getNovelDownloadGoal(novel.id) }).data?.goal ?? null;
  const defaultKeepAhead = useDownloadGoalSettingsStore((state) => state.defaultKeepAhead);
  const cooldownSeconds = useBrowseStore((state) => state.chapterDownloadCooldownSeconds);
  const { pause } = useSyncExternalStore(subscribeDownloadGoalPause, getDownloadGoalPauseSnapshot, getDownloadGoalPauseSnapshot);
  const snapshot = useTaskSnapshot();
  const { choose, error, saving } = useNovelDownloadGoalChoice({
    chapters,
    downloadStatuses,
    lastReadChapterId,
    novel,
    onClose,
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { goal, isDefault } = effectiveDownloadGoal(ownGoal, novel, defaultKeepAhead, nowSeconds);
  const progress = describeDownloadGoalProgress(goal, chapters, lastReadChapterId, downloadStatuses);
  const sourceMissing = goal !== null && !pluginManager.getPlugin(novel.pluginId);

  const status = (() => {
    if (sourceMissing) return t("downloadGoals.status.sourceUnavailable");
    const withImages = (text: string, missingImages: number) => missingImages > 0
      ? `${text} · ${t("downloadGoals.status.missingImages", { count: missingImages })}` : text;
    switch (progress.kind) {
      case "none":
        return withImages(t("downloadGoals.status.onDevice", { count: progress.onDevice }), progress.missingImages);
      case "satisfied":
        return withImages(t("downloadGoals.status.satisfied", { count: progress.onDevice }), progress.missingImages);
      case "waiting":
        return pause !== null
          ? t("downloadGoals.status.paused")
          : t("downloadGoals.status.waiting", { count: progress.remaining });
      case "downloading": {
        const parts = [t("downloadGoals.status.downloading", { done: progress.done, total: progress.total })];
        const etaMs = estimateNovelDownloadMs(novel.id, snapshot.records, cooldownSeconds * 1000);
        if (etaMs !== null) {
          const eta = formatDownloadEta(etaMs);
          parts.push(t(eta.key, { count: eta.minutes }));
        }
        const route = novelDownloadRoute(novel.id, snapshot.records);
        if (route) parts.push(t(`downloadGoals.route.${route}`));
        return parts.join(" · ");
      }
    }
  })();

  const remaining = goalTargetChapters({ kind: "all_remaining" }, chapters, lastReadChapterId).length;

  return (
    <Stack gap="md">
      <div className="norea-download-goal-status">
        <p className="norea-download-goal-status-line" data-download-goal-status={progress.kind} role="status">{status}</p>
        {isDefault ? (
          <p className="norea-download-goal-status-note">{t("downloadGoals.status.defaultApplies", { count: defaultKeepAhead })}</p>
        ) : null}
      </div>
      <DownloadGoalSection title={t("downloadGoals.section.goal")}>
        {error ? (
          <StateView
            color="danger"
            details={{ content: describeError(error), label: t("common.details") }}
            title={t("downloadGoals.chosen.failed")}
          />
        ) : null}
        <DownloadGoalChoices
          allRemainingDescription={t("downloadGoals.kind.allRemaining.description", { count: remaining })}
          current={ownGoal}
          disabled={saving}
          entireDescription={t("downloadGoals.kind.entire.description", { count: chapters.length })}
          onChoose={(next) => void choose(next, ownGoal)}
          pending={saving}
        />
      </DownloadGoalSection>
      <DownloadGoalSection title={t("downloadGoals.section.once")}>
        <ListRow
          disabled={chapters.length === 0}
          leading={<SelectIcon size="1.25rem" />}
          onClick={() => { onClose(); onSelectChapters(); }}
          subtitle={t("downloadGoals.once.selected.description")}
          title={t("downloadGoals.once.selected")}
          trailing={<ChevronRightIcon size="1.125rem" />}
        />
      </DownloadGoalSection>
    </Stack>
  );
}

interface ChapterSortPickerProps {
  onChange: (value: DefaultChapterSort) => void;
  value: DefaultChapterSort;
}

export function ChapterSortPicker({ onChange, value }: ChapterSortPickerProps) {
  const { t } = useTranslation();
  const activeLabel = t(DEFAULT_CHAPTER_SORT_LABEL_KEYS[value]);
  const nextValue: DefaultChapterSort = value === "desc" ? "asc" : "desc";

  return (
    <IconButton
      active={value === "desc"}
      className="norea-novel-chapter-sort-button"
      data-sort-direction={value}
      label={`${t("librarySettings.defaultChapterSort")}: ${activeLabel}`}
      onClick={() => onChange(nextValue)}
      size="lg"
    >
      <SortIcon />
    </IconButton>
  );
}
