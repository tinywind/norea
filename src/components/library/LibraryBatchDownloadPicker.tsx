import { Popover, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { type TranslationKey } from "../../i18n";
import { DownloadGlyph } from "../ActionGlyphs";
import { IconButton } from "../IconButton";
import { type LibraryBatchDownloadMode } from "./library-batch-download";
import { type TranslateFn } from "./LibraryFilters";
interface LibraryBatchDownloadOptionConfig {
  descriptionKey: TranslationKey;
  labelKey: TranslationKey;
  mode: LibraryBatchDownloadMode;
}

interface LibraryBatchDownloadPickerProps {
  available: boolean;
  onDownload: (mode: LibraryBatchDownloadMode) => void;
  preparing: boolean;
  t: TranslateFn;
}

const LIBRARY_BATCH_DOWNLOAD_OPTIONS: LibraryBatchDownloadOptionConfig[] = [
  {
    descriptionKey: "library.batchDownload.allDescription",
    labelKey: "novel.batchDownload.all",
    mode: "all",
  },
  {
    descriptionKey: "library.batchDownload.unreadDescription",
    labelKey: "novel.batchDownload.unread",
    mode: "unread",
  },
  {
    descriptionKey: "library.batchDownload.next10Description",
    labelKey: "novel.batchDownload.next10",
    mode: "next10",
  },
  {
    descriptionKey: "library.batchDownload.next30Description",
    labelKey: "novel.batchDownload.next30",
    mode: "next30",
  },
];

export function LibraryBatchDownloadPicker({
  available,
  onDownload,
  preparing,
  t,
}: LibraryBatchDownloadPickerProps) {
  const [opened, setOpened] = useState(false);
  const disabled = preparing || !available;

  return (
    <Popover
      opened={opened && !disabled}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      width={280}
    >
      <Popover.Target>
        <IconButton
          className="norea-library-selection-icon"
          disabled={disabled}
          label={t("library.batchDownload.open")}
          onClick={() => setOpened((current) => !current)}
          size="sm"
          title={t(
            available
              ? "library.batchDownload.open"
              : "library.batchDownload.unavailable",
          )}
        >
          <DownloadGlyph />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="norea-library-batch-download-popover">
        <div className="norea-library-batch-download-list">
          {LIBRARY_BATCH_DOWNLOAD_OPTIONS.map((option) => (
            <UnstyledButton
              className="norea-library-batch-download-option"
              disabled={disabled}
              key={option.mode}
              onClick={() => {
                onDownload(option.mode);
                setOpened(false);
              }}
            >
              <span className="norea-library-batch-download-label">
                {t(option.labelKey)}
              </span>
              <span className="norea-library-batch-download-description">
                {t(option.descriptionKey)}
              </span>
            </UnstyledButton>
          ))}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
