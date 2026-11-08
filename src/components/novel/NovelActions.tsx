import { Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { hasStoredChapterContent, type ChapterListRow } from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { describeError } from "../../lib/errors";
import { readServerNovelSource } from "../../lib/content-sync/novel-source";
import { DEFAULT_CHAPTER_SORT_LABEL_KEYS } from "../../lib/library-settings-options";
import { pluginManager } from "../../lib/plugins/manager";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { type DefaultChapterSort } from "../../store/library";
import { useContentSyncStore } from "../../store/content-sync";
import { StateView } from "../AppFrame";
import { DownloadOnceChoices } from "../DownloadOnceChoices";
import { BRIEF_TOAST_AUTO_CLOSE_MS } from "../ui/AppToasts";
import { IconButton } from "../IconButton";
import { SortIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { downloadOnceNotice, queueChapterDownloadsOnce, type DownloadOnceSelection } from "../library/download-once";

interface NovelDownloadSheetProps {
  chapters: readonly ChapterListRow[];
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>;
  novel: NovelDetailRecord;
  hasServerSource?: boolean;
  onClose: () => void;
  onSelectChapters: () => void;
  opened: boolean;
}

/** The work's download button queues one immediate request; automatic policy stays in Settings. */
export function NovelDownloadSheet({ onClose, opened, ...props }: NovelDownloadSheetProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveSheet onClose={onClose} opened={opened} title={t("novel.download")}>
      {opened ? <NovelDownloadChoices onClose={onClose} {...props} /> : null}
    </ResponsiveSheet>
  );
}

/** Keeps the sheet open when queue publication fails and closes only after the chosen request is admitted. */
export function useNovelDownloadOnce({ novelId, onClose, serverOnly = false }: { novelId: number; onClose: () => void; serverOnly?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const choose = async (selection: DownloadOnceSelection) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const fromServer = serverOnly || Boolean(await readServerNovelSource(novelId));
      const result = fromServer
        ? await queueChapterDownloadsOnce([novelId], t, queryClient, selection, { serverOnly: true })
        : await queueChapterDownloadsOnce([novelId], t, queryClient, selection);
      onClose();
      notifications.show({ autoClose: BRIEF_TOAST_AUTO_CLOSE_MS, ...downloadOnceNotice(t, result) });
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };
  return { choose, error, saving };
}

function NovelDownloadChoices({ chapters, downloadStatuses, novel, hasServerSource = false, onClose, onSelectChapters }: Omit<NovelDownloadSheetProps, "opened">) {
  const { t } = useTranslation();
  const { choose, error, saving } = useNovelDownloadOnce({ novelId: novel.id, onClose, serverOnly: hasServerSource });
  const stored = chapters.filter(hasStoredChapterContent).length;
  const queued = chapters.filter(chapter => {
    const kind = downloadStatuses.get(chapter.id)?.kind;
    return kind === "queued" || kind === "running";
  }).length;
  const missingImages = chapters.filter(chapter => chapter.mediaRepairNeeded).length;
  const serverUrl = useContentSyncStore(state => state.serverUrl);
  const sourceMissing = !pluginManager.getPlugin(novel.pluginId) && !hasServerSource && !serverUrl;
  return (
    <Stack gap="md">
      <Text role="status" size="sm">
        {t("downloadOnce.status", { stored, total: chapters.length, queued })}
        {missingImages > 0 ? ` · ${t("downloadGoals.status.missingImages", { count: missingImages })}` : ""}
      </Text>
      {sourceMissing ? <Text c="dimmed" size="sm">{t("downloadGoals.status.sourceUnavailable")}</Text> : null}
      {error ? <StateView color="danger" details={{ content: describeError(error), label: t("common.details") }}
        title={t("downloadOnce.failed")} /> : null}
      <DownloadOnceChoices disabled={saving || sourceMissing || chapters.length === 0}
        onChoose={selection => void choose(selection)} onClose={onClose} onSelectChapters={onSelectChapters} />
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
