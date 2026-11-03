import { Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { getNovelDownloadGoal, type NovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { estimateNovelDownloadMs, novelDownloadRoute } from "../../lib/download-goals/download-eta";
import {
  getDownloadGoalPauseSnapshot,
  setDownloadGoal,
  subscribeDownloadGoalPause,
} from "../../lib/download-goals/goal-service";
import { describeDownloadGoalProgress, formatDownloadEta } from "../../lib/download-goals/goal-status";
import { effectiveDownloadGoal, goalTargetChapters } from "../../lib/download-goals/goal-targets";
import { DEFAULT_CHAPTER_SORT_LABEL_KEYS } from "../../lib/library-settings-options";
import { pluginManager } from "../../lib/plugins/manager";
import { showErrorToast } from "../../lib/runtime/error-toast";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { useTaskSnapshot } from "../../lib/tasks/hooks";
import { useBrowseStore } from "../../store/browse";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { type DefaultChapterSort } from "../../store/library";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";
import { IconButton } from "../IconButton";
import { SegmentedToggle } from "../SegmentedToggle";
import { CheckIcon, SortIcon } from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

export const KEEP_AHEAD_GOAL_CHOICES = [3, 5, 10, 30] as const;

export const novelDownloadGoalQueryKey = (novelId: number) => ["download-goal", novelId] as const;

interface NovelDownloadGoalSheetProps {
  chapters: readonly ChapterListRow[];
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>;
  lastReadChapterId: number | undefined;
  novel: NovelDetailRecord;
  onClose: () => void;
  /** "Selected chapters once": hands over to chapter selection. */
  onSelectChapters: () => void;
  opened: boolean;
}

const sameGoal = (left: NovelDownloadGoal | null, right: NovelDownloadGoal | null) =>
  JSON.stringify(left) === JSON.stringify(right);

/** The novel's download goal choices with a status line for the goal in effect. */
export function NovelDownloadGoalSheet({ onClose, opened, ...props }: NovelDownloadGoalSheetProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveSheet onClose={onClose} opened={opened} title={t("novel.download")}>
      {opened ? <NovelDownloadGoalChoices onClose={onClose} {...props} /> : null}
    </ResponsiveSheet>
  );
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
  const queryClient = useQueryClient();
  const queryKey = novelDownloadGoalQueryKey(novel.id);
  const ownGoal = useQuery({ queryKey, queryFn: () => getNovelDownloadGoal(novel.id) }).data?.goal ?? null;
  const defaultKeepAhead = useDownloadGoalSettingsStore((state) => state.defaultKeepAhead);
  const cooldownSeconds = useBrowseStore((state) => state.chapterDownloadCooldownSeconds);
  const { pause } = useSyncExternalStore(subscribeDownloadGoalPause, getDownloadGoalPauseSnapshot, getDownloadGoalPauseSnapshot);
  const snapshot = useTaskSnapshot();
  const [keepAheadCount, setKeepAheadCount] = useState<number>(KEEP_AHEAD_GOAL_CHOICES[0]);
  const [saving, setSaving] = useState(false);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { goal, isDefault } = effectiveDownloadGoal(ownGoal, novel, defaultKeepAhead, nowSeconds);
  const fallbackDefault = effectiveDownloadGoal(null, novel, defaultKeepAhead, nowSeconds);
  const progress = describeDownloadGoalProgress(goal, chapters, lastReadChapterId, downloadStatuses);
  const shownKeepAheadCount = ownGoal?.kind === "keep_ahead" ? ownGoal.count : keepAheadCount;
  const sourceMissing = goal !== null && !pluginManager.getPlugin(novel.pluginId);

  const choose = async (next: NovelDownloadGoal | null) => {
    if (saving || sameGoal(next, ownGoal)) return;
    setSaving(true);
    try {
      await setDownloadGoal(novel.id, next);
      queryClient.setQueryData(queryKey, next ? { novelId: novel.id, goal: next, updatedAt: Date.now() } : null);
      void queryClient.invalidateQueries({ queryKey: DOWNLOAD_GOALS_QUERY_KEY });
    } catch (error) {
      showErrorToast(t("novel.download"), error);
    } finally {
      setSaving(false);
    }
  };

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
  const choiceRow = (key: string, choice: NovelDownloadGoal | null, title: string, subtitle: string) => {
    const selected = sameGoal(choice, ownGoal) || (choice?.kind === "keep_ahead" && ownGoal?.kind === "keep_ahead");
    return (
      <ListRow
        aria-pressed={selected}
        disabled={saving}
        key={key}
        leading={selected ? <CheckIcon size="1.125rem" /> : <span aria-hidden="true" className="norea-download-goal-spacer" />}
        onClick={() => void choose(choice)}
        selected={selected}
        subtitle={subtitle}
        title={title}
      />
    );
  };

  return (
    <Stack gap="xs">
      <Text c="dimmed" data-download-goal-status={progress.kind} role="status" size="sm">{status}</Text>
      <Stack gap={0}>
        {choiceRow("none", null, t("downloadGoals.kind.none"), fallbackDefault.goal?.kind === "keep_ahead"
          ? t("downloadGoals.kind.none.default", { count: fallbackDefault.goal.count })
          : t("downloadGoals.kind.none.description"))}
        {choiceRow("keep", { kind: "keep_ahead", count: shownKeepAheadCount }, t("downloadGoals.kind.keepAhead"),
          t("downloadGoals.kind.keepAhead.description", { count: shownKeepAheadCount }))}
        <SegmentedToggle
          aria-label={t("downloadGoals.kind.keepAhead.countLabel")}
          className="norea-download-goal-count"
          data={KEEP_AHEAD_GOAL_CHOICES.map((count) => ({ value: String(count), label: String(count) }))}
          disabled={saving}
          onChange={(value) => {
            const count = Number(value);
            setKeepAheadCount(count);
            if (ownGoal?.kind === "keep_ahead") void choose({ kind: "keep_ahead", count });
          }}
          value={String(shownKeepAheadCount)}
        />
        {choiceRow("remaining", { kind: "all_remaining" }, t("downloadGoals.kind.allRemaining"),
          t("downloadGoals.kind.allRemaining.description", { count: remaining }))}
        {choiceRow("entire", { kind: "entire" }, t("downloadGoals.kind.entire"),
          t("downloadGoals.kind.entire.description", { count: chapters.length }))}
        <ListRow
          disabled={chapters.length === 0}
          leading={<span aria-hidden="true" className="norea-download-goal-spacer" />}
          onClick={() => { onClose(); onSelectChapters(); }}
          subtitle={t("downloadGoals.kind.selected.description")}
          title={t("downloadGoals.kind.selected")}
        />
      </Stack>
      {isDefault ? (
        <Text c="dimmed" size="xs">{t("downloadGoals.status.defaultApplies", { count: defaultKeepAhead })}</Text>
      ) : null}
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
