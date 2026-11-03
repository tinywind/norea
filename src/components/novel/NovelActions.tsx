import { Loader, Popover, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { useTranslation } from "../../i18n";
import { DEFAULT_CHAPTER_SORT_LABEL_KEYS } from "../../lib/library-settings-options";
import { type DefaultChapterSort } from "../../store/library";
import { MoreGlyph } from "../ActionGlyphs";
import { IconButton } from "../IconButton";
import { SortIcon } from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { type BatchDownloadOption } from "./novel-detail-model";

interface NovelDownloadSheetProps {
  onClose: () => void;
  onDownload: (chapters: ChapterListRow[]) => void;
  opened: boolean;
  options: readonly BatchDownloadOption[];
}

/** The novel's download choices, each with the chapters it would queue. */
export function NovelDownloadSheet({
  onClose,
  onDownload,
  opened,
  options,
}: NovelDownloadSheetProps) {
  const { t } = useTranslation();

  return (
    <ResponsiveSheet
      onClose={onClose}
      opened={opened}
      title={t("novel.batchDownload.open")}
    >
      <Stack gap={0}>
        {options.map((option) => (
          <ListRow
            disabled={option.chapters.length === 0}
            key={option.key}
            onClick={() => {
              onDownload(option.chapters);
              onClose();
            }}
            title={option.label}
            trailing={
              <Text c="dimmed" size="sm">
                {option.description}
              </Text>
            }
          />
        ))}
      </Stack>
    </ResponsiveSheet>
  );
}
interface ChapterRelativeReadMenuProps {
  afterCount: number;
  beforeCount: number;
  busy: boolean;
  previousDownloadCount: number;
  onDownloadPrevious: () => void;
  showReadActions: boolean;
  onMarkFollowingUnread: () => void;
  onMarkPreviousRead: () => void;
}

export function ChapterRelativeReadMenu({
  afterCount,
  beforeCount,
  busy,
  previousDownloadCount,
  onDownloadPrevious,
  showReadActions,
  onMarkFollowingUnread,
  onMarkPreviousRead,
}: ChapterRelativeReadMenuProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      width={280}
    >
      <Popover.Target>
        <IconButton
          className="norea-novel-selection-icon norea-state-layer"
          disabled={busy || (previousDownloadCount === 0 && (!showReadActions || (beforeCount === 0 && afterCount === 0)))}
          label={t("novel.selection.moreActions")}
          onClick={() => setOpened((current) => !current)}
          size="sm"
          title={t("novel.selection.moreActions")}
        >
          {busy ? <Loader size={14} /> : <MoreGlyph />}
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="norea-novel-batch-download-menu">
        <div className="norea-novel-batch-download-list">
          <button
            className="norea-novel-batch-download-option norea-state-layer"
            disabled={busy || previousDownloadCount === 0}
            onClick={() => {
              onDownloadPrevious();
              setOpened(false);
            }}
            type="button"
          >
            <span className="norea-novel-batch-download-label">
              {t("novel.selection.downloadPrevious")}
            </span>
            <span className="norea-novel-batch-download-description">
              {t("novel.selection.downloadPreviousDescription", { count: previousDownloadCount })}
            </span>
          </button>
          {showReadActions ? <>
          <button
            className="norea-novel-batch-download-option norea-state-layer"
            disabled={busy || beforeCount === 0}
            onClick={() => {
              onMarkPreviousRead();
              setOpened(false);
            }}
            type="button"
          >
            <span className="norea-novel-batch-download-label">
              {t("novel.selection.markPreviousRead")}
            </span>
            <span className="norea-novel-batch-download-description">
              {t("novel.selection.markPreviousReadDescription", {
                count: beforeCount,
              })}
            </span>
          </button>
          <button
            className="norea-novel-batch-download-option norea-state-layer"
            disabled={busy || afterCount === 0}
            onClick={() => {
              onMarkFollowingUnread();
              setOpened(false);
            }}
            type="button"
          >
            <span className="norea-novel-batch-download-label">
              {t("novel.selection.markFollowingUnread")}
            </span>
            <span className="norea-novel-batch-download-description">
              {t("novel.selection.markFollowingUnreadDescription", {
                count: afterCount,
              })}
            </span>
          </button>
          </> : null}
        </div>
      </Popover.Dropdown>
    </Popover>
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

export function SelectionClearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5h14v14H5z" />
      <path d="M8 12h8" />
    </svg>
  );
}
