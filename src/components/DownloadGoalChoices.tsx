import { Stack } from "@mantine/core";
import { useState } from "react";
import type { NovelDownloadGoal } from "../db/queries/novel-download-goal";
import { useTranslation } from "../i18n";
import { AUTOMATIC_KEEP_AHEAD_CHOICES } from "../store/download-goals";
import { SegmentedToggle } from "./SegmentedToggle";
import { ListRow } from "./ui/ListRow";
import "../styles/download-goals.css";

interface DownloadGoalChoicesProps {
  current: NovelDownloadGoal;
  disabled: boolean;
  onChoose: (goal: NovelDownloadGoal) => void;
}

/** The single automatic download policy, edited only in Settings. */
export function DownloadGoalChoices({ current, disabled, onChoose }: DownloadGoalChoicesProps) {
  const { t } = useTranslation();
  const [keepAheadCount, setKeepAheadCount] = useState(3);
  const shownKeepAheadCount = current.kind === "keep_ahead" ? current.count : keepAheadCount;
  const choiceRow = (choice: NovelDownloadGoal, title: string, subtitle: string) => {
    const selected = choice.kind === current.kind;
    return (
      <ListRow aria-checked={selected} disabled={disabled} key={choice.kind}
        leading={<span aria-hidden="true" className="norea-download-goal-radio" data-checked={selected || undefined} />}
        onClick={() => onChoose(choice)} role="radio" selected={selected} subtitle={subtitle} title={title} />
    );
  };
  return (
    <Stack aria-label={t("downloadGoals.section.goal")} gap={0} role="radiogroup">
      {choiceRow({ kind: "none" }, t("downloadGoals.kind.none"), t("downloadGoals.kind.none.description"))}
      {choiceRow({ kind: "keep_ahead", count: shownKeepAheadCount }, t("downloadGoals.kind.keepAhead"),
        t("downloadGoals.kind.keepAhead.description", { count: shownKeepAheadCount }))}
      <SegmentedToggle
        aria-label={t("downloadGoals.kind.keepAhead.countLabel")}
        className="norea-download-goal-count"
        data={AUTOMATIC_KEEP_AHEAD_CHOICES.map(count => ({ value: String(count), label: String(count) }))}
        disabled={disabled}
        onChange={value => {
          const count = Number(value);
          setKeepAheadCount(count);
          onChoose({ kind: "keep_ahead", count });
        }}
        value={String(shownKeepAheadCount)}
      />
      {choiceRow({ kind: "all_remaining" }, t("downloadGoals.kind.allRemaining"), t("downloadGoals.kind.allRemaining.many"))}
      {choiceRow({ kind: "entire" }, t("downloadGoals.kind.entire"), t("downloadGoals.kind.entire.many"))}
    </Stack>
  );
}
