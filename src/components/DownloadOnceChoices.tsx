import { Stack, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "../i18n";
import type { DownloadOnceSelection } from "./library/download-once";
import { SegmentedToggle } from "./SegmentedToggle";
import { ChevronRightIcon, DownloadIcon, SelectIcon, SettingsIcon } from "./ui/icons";
import { ListRow } from "./ui/ListRow";
import "../styles/download-goals.css";

const DOWNLOAD_COUNT_CHOICES = [3, 5, 10, 30] as const;

interface DownloadOnceChoicesProps {
  disabled: boolean;
  onChoose: (selection: DownloadOnceSelection) => void;
  onClose: () => void;
  onSelectChapters?: () => void;
}

/** Immediate requests share the same ranges in the library and a work's download sheet. */
export function DownloadOnceChoices({ disabled, onChoose, onClose, onSelectChapters }: DownloadOnceChoicesProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [count, setCount] = useState<number>(DOWNLOAD_COUNT_CHOICES[0]);
  const action = (selection: DownloadOnceSelection, title: string, subtitle: string) => (
    <ListRow disabled={disabled} leading={<DownloadIcon size="1.25rem" />} onClick={() => onChoose(selection)}
      subtitle={subtitle} title={title} trailing={<ChevronRightIcon size="1.125rem" />} />
  );
  return (
    <Stack gap="xs">
      <Text c="dimmed" size="sm">{t("downloadOnce.description")}</Text>
      <Stack className="norea-download-once-count-group" gap="xs">
        <Text c="dimmed" size="xs">{t("downloadOnce.countLabel")}</Text>
        <SegmentedToggle
          aria-label={t("downloadOnce.countLabel")}
          className="norea-download-goal-count"
          data={DOWNLOAD_COUNT_CHOICES.map(value => ({ value: String(value), label: String(value) }))}
          disabled={disabled}
          fullWidth
          onChange={value => setCount(Number(value))}
          value={String(count)}
        />
      </Stack>
      {action(
        { kind: "afterLastDownloaded", count },
        t("downloadOnce.afterLastDownloaded", { count }),
        t("downloadOnce.afterLastDownloaded.description", { count }),
      )}
      {action(
        { kind: "fromStartMissing", count },
        t("downloadOnce.fromStartMissing", { count }),
        t("downloadOnce.fromStartMissing.description", { count }),
      )}
      {action({ kind: "remaining" }, t("downloadOnce.remaining"), t("downloadOnce.remaining.description"))}
      {action({ kind: "all" }, t("downloadOnce.all"), t("downloadOnce.all.description"))}
      {onSelectChapters ? (
        <ListRow disabled={disabled} leading={<SelectIcon size="1.25rem" />}
          onClick={() => { onClose(); onSelectChapters(); }} subtitle={t("downloadGoals.once.selected.description")}
          title={t("downloadGoals.once.selected")} trailing={<ChevronRightIcon size="1.125rem" />} />
      ) : null}
      <ListRow leading={<SettingsIcon size="1.25rem" />}
        onClick={() => { onClose(); void navigate({ to: "/settings", search: { section: "downloads" } }); }}
        subtitle={t("downloadOnce.settings.description")} title={t("downloadOnce.settings")}
        trailing={<ChevronRightIcon size="1.125rem" />} />
    </Stack>
  );
}
