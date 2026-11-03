import { Stack, Text } from "@mantine/core";
import { type ChapterListRow } from "../../db/queries/chapter";
import { useTranslation } from "../../i18n";
import { DEFAULT_CHAPTER_SORT_LABEL_KEYS } from "../../lib/library-settings-options";
import { type DefaultChapterSort } from "../../store/library";
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
