import { Radio, Stack } from "@mantine/core";
import { useTranslation } from "../../i18n";
import {
  LIBRARY_DISPLAY_MODE_LABEL_KEYS,
  LIBRARY_DISPLAY_MODES,
} from "../../lib/library-settings-options";
import {
  MAX_SOURCE_NOVELS_PER_ROW,
  MIN_SOURCE_NOVELS_PER_ROW,
  useBrowseStore,
} from "../../store/browse";
import type { LibraryDisplayMode } from "../../store/library";
import { IconButton } from "../IconButton";
import { MinusIcon, PlusIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

interface SourceDisplaySheetProps {
  opened: boolean;
  onClose: () => void;
}

export function SourceDisplaySheet({
  opened,
  onClose,
}: SourceDisplaySheetProps) {
  const { t } = useTranslation();
  const displayMode = useBrowseStore((state) => state.sourceDisplayMode);
  const setDisplayMode = useBrowseStore((state) => state.setSourceDisplayMode);
  const novelsPerRow = useBrowseStore((state) => state.sourceNovelsPerRow);
  const setNovelsPerRow = useBrowseStore((state) => state.setSourceNovelsPerRow);
  const listMode = displayMode === "list";

  return (
    <ResponsiveSheet
      desktopVariant="side"
      onClose={onClose}
      opened={opened}
      title={t("library.viewOptions.display")}
    >
      <Stack className="norea-source-display-options" gap="lg">
        <Radio.Group
          label={t("librarySettings.displayMode")}
          onChange={(value) => setDisplayMode(value as LibraryDisplayMode)}
          value={displayMode}
        >
          <Stack className="norea-source-option-list" gap={0}>
            {LIBRARY_DISPLAY_MODES.map((mode) => (
              <Radio
                key={mode}
                label={t(LIBRARY_DISPLAY_MODE_LABEL_KEYS[mode])}
                value={mode}
              />
            ))}
          </Stack>
        </Radio.Group>
        <div className="norea-source-stepper-row">
          <span className="norea-source-stepper-label" id="source-columns-label">
            {t("librarySettings.novelsPerRow")}
          </span>
          <div
            aria-labelledby="source-columns-label"
            className="norea-source-stepper"
            role="group"
          >
            <IconButton
              disabled={listMode || novelsPerRow <= MIN_SOURCE_NOVELS_PER_ROW}
              label={t("library.viewOptions.fewerColumns")}
              onClick={() => setNovelsPerRow(novelsPerRow - 1)}
              size="lg"
            >
              <MinusIcon size="1.125rem" />
            </IconButton>
            <output aria-live="polite" className="norea-source-stepper-value">
              {novelsPerRow}
            </output>
            <IconButton
              disabled={listMode || novelsPerRow >= MAX_SOURCE_NOVELS_PER_ROW}
              label={t("library.viewOptions.moreColumns")}
              onClick={() => setNovelsPerRow(novelsPerRow + 1)}
              size="lg"
            >
              <PlusIcon size="1.125rem" />
            </IconButton>
          </div>
        </div>
      </Stack>
    </ResponsiveSheet>
  );
}
