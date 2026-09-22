import { Loader, Popover } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { useTranslation } from "../../i18n";
import { DEFAULT_CHAPTER_SORT_LABEL_KEYS } from "../../lib/library-settings-options";
import { type DefaultChapterSort } from "../../store/library";
import {
  DownloadGlyph,
  MoreGlyph,
  RefreshGlyph,
  SortGlyph,
} from "../ActionGlyphs";
import { IconButton } from "../IconButton";
import { type BatchDownloadOption } from "./novel-detail-model";
interface NovelActionButtonProps {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone?: "default" | "accent" | "success";
}

interface NovelBatchDownloadMenuProps {
  disabled: boolean;
  onDownload: (chapters: ChapterListRow[]) => void;
  options: BatchDownloadOption[];
}

interface NovelMetadataRefreshMenuProps {
  fullRefreshing: boolean;
  onFullRefresh: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

interface ChapterRelativeReadMenuProps {
  afterCount: number;
  beforeCount: number;
  busy: boolean;
  onMarkFollowingUnread: () => void;
  onMarkPreviousRead: () => void;
}

export function NovelActionButton({
  active = false,
  children,
  disabled = false,
  label,
  onClick,
  pressed,
  tone = "default",
}: NovelActionButtonProps) {
  return (
    <IconButton
      active={active}
      aria-pressed={pressed}
      className="norea-novel-icon-button"
      disabled={disabled}
      label={label}
      onClick={onClick}
      size="lg"
      tone={tone}
    >
      {children}
    </IconButton>
  );
}

export function NovelBatchDownloadMenu({
  disabled,
  onDownload,
  options,
}: NovelBatchDownloadMenuProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      width={260}
    >
      <Popover.Target>
        <IconButton
          className="norea-novel-icon-button"
          disabled={disabled}
          label={t("novel.batchDownload.open")}
          onClick={() => setOpened((current) => !current)}
          size="lg"
        >
          <DownloadGlyph />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="norea-novel-batch-download-menu">
        <div className="norea-novel-batch-download-list">
          {options.map((option) => (
            <button
              className="norea-novel-batch-download-option"
              disabled={option.chapters.length === 0}
              key={option.key}
              onClick={() => {
                onDownload(option.chapters);
                setOpened(false);
              }}
              type="button"
            >
              <span className="norea-novel-batch-download-label">
                {option.label}
              </span>
              <span className="norea-novel-batch-download-description">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

export function ChapterRelativeReadMenu({
  afterCount,
  beforeCount,
  busy,
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
          className="norea-novel-selection-icon"
          disabled={busy || (beforeCount === 0 && afterCount === 0)}
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
            className="norea-novel-batch-download-option"
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
            className="norea-novel-batch-download-option"
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
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

export function NovelMetadataRefreshMenu({
  fullRefreshing,
  onFullRefresh,
  onRefresh,
  refreshing,
}: NovelMetadataRefreshMenuProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const busy = refreshing || fullRefreshing;

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
          className="norea-novel-icon-button"
          disabled={busy}
          label={t("novel.refreshMetadataMenu")}
          onClick={() => setOpened((current) => !current)}
          size="lg"
        >
          {busy ? <Loader size={14} /> : <RefreshGlyph />}
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="norea-novel-batch-download-menu">
        <div className="norea-novel-batch-download-list">
          <button
            className="norea-novel-batch-download-option"
            disabled={busy}
            onClick={() => {
              onRefresh();
              setOpened(false);
            }}
            type="button"
          >
            <span className="norea-novel-batch-download-label">
              {t("novel.refreshMetadata")}
            </span>
            <span className="norea-novel-batch-download-description">
              {t("novel.refreshMetadataDescription")}
            </span>
          </button>
          <button
            className="norea-novel-batch-download-option"
            disabled={busy}
            onClick={() => {
              onFullRefresh();
              setOpened(false);
            }}
            type="button"
          >
            <span className="norea-novel-batch-download-label">
              {t("novel.refreshMetadataFull")}
            </span>
            <span className="norea-novel-batch-download-description">
              {t("novel.refreshMetadataFullDescription")}
            </span>
          </button>
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
      className="norea-novel-icon-button norea-novel-chapter-sort-button"
      data-sort-direction={value}
      label={activeLabel}
      onClick={() => onChange(nextValue)}
      size="lg"
      title={`${t("librarySettings.defaultChapterSort")}: ${activeLabel}`}
    >
      <SortGlyph />
    </IconButton>
  );
}

interface NovelReadButtonProps {
  children: ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  tone?: "default" | "accent";
}

export function NovelReadButton({
  children,
  disabled,
  label,
  onClick,
  tone = "default",
}: NovelReadButtonProps) {
  return (
    <IconButton
      className="norea-novel-read-icon-button"
      disabled={disabled}
      label={label}
      onClick={onClick}
      size="lg"
      tone={tone}
    >
      {children}
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
