import { Stack } from "@mantine/core";
import { useState, type ReactNode } from "react";
import type { NovelDownloadGoal } from "../db/queries/novel-download-goal";
import { useTranslation } from "../i18n";
import { useDownloadGoalSettingsStore } from "../store/download-goals";
import { SegmentedToggle } from "./SegmentedToggle";
import { CheckIcon } from "./ui/icons";
import { ListRow } from "./ui/ListRow";
import "../styles/download-goals.css";

export const KEEP_AHEAD_GOAL_CHOICES = [3, 5, 10, 30] as const;

export const sameDownloadGoal = (left: NovelDownloadGoal | null, right: NovelDownloadGoal | null) =>
  JSON.stringify(left) === JSON.stringify(right);

interface DownloadGoalChoicesProps {
  /** The own goal every novel shares, null when all follow the default, undefined when they differ. */
  current: NovelDownloadGoal | null | undefined;
  disabled: boolean;
  /** Null returns the novels to the default keep-ahead. */
  onChoose: (goal: NovelDownloadGoal | null) => void;
  allRemainingDescription: string;
  entireDescription: string;
  /** Rows after the goal choices, such as a one-time selection. */
  children?: ReactNode;
}

export function DownloadGoalSpacer() {
  return <span aria-hidden="true" className="norea-download-goal-spacer" />;
}

/** Use default, None, Keep N ahead, All remaining and Entire novel, with the shared goal marked. */
export function DownloadGoalChoices({
  allRemainingDescription,
  children,
  current,
  disabled,
  entireDescription,
  onChoose,
}: DownloadGoalChoicesProps) {
  const { t } = useTranslation();
  const defaultKeepAhead = useDownloadGoalSettingsStore((state) => state.defaultKeepAhead);
  const [keepAheadCount, setKeepAheadCount] = useState<number>(KEEP_AHEAD_GOAL_CHOICES[0]);
  const shownKeepAheadCount = current?.kind === "keep_ahead" ? current.count : keepAheadCount;

  const choiceRow = (key: string, choice: NovelDownloadGoal | null, title: string, subtitle: string) => {
    const selected = current !== undefined &&
      (sameDownloadGoal(choice, current) || (choice?.kind === "keep_ahead" && current?.kind === "keep_ahead"));
    return (
      <ListRow
        aria-pressed={selected}
        disabled={disabled}
        key={key}
        leading={selected ? <CheckIcon size="1.125rem" /> : <DownloadGoalSpacer />}
        onClick={() => onChoose(choice)}
        selected={selected}
        subtitle={subtitle}
        title={title}
      />
    );
  };

  return (
    <Stack gap={0}>
      {choiceRow("default", null, t("downloadGoals.kind.default"), defaultKeepAhead > 0
        ? t("downloadGoals.kind.default.keepAhead", { count: defaultKeepAhead })
        : t("downloadGoals.kind.default.off"))}
      {choiceRow("none", { kind: "none" }, t("downloadGoals.kind.none"), t("downloadGoals.kind.none.description"))}
      {choiceRow("keep", { kind: "keep_ahead", count: shownKeepAheadCount }, t("downloadGoals.kind.keepAhead"),
        t("downloadGoals.kind.keepAhead.description", { count: shownKeepAheadCount }))}
      <SegmentedToggle
        aria-label={t("downloadGoals.kind.keepAhead.countLabel")}
        className="norea-download-goal-count"
        data={KEEP_AHEAD_GOAL_CHOICES.map((count) => ({ value: String(count), label: String(count) }))}
        disabled={disabled}
        onChange={(value) => {
          const count = Number(value);
          setKeepAheadCount(count);
          if (current?.kind === "keep_ahead") onChoose({ kind: "keep_ahead", count });
        }}
        value={String(shownKeepAheadCount)}
      />
      {choiceRow("remaining", { kind: "all_remaining" }, t("downloadGoals.kind.allRemaining"), allRemainingDescription)}
      {choiceRow("entire", { kind: "entire" }, t("downloadGoals.kind.entire"), entireDescription)}
      {children}
    </Stack>
  );
}
