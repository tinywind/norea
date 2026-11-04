import {
  Checkbox,
  Radio,
  Stack,
  Switch,
  Tabs,
  Text,
} from "@mantine/core";
import { SegmentedToggle } from "../SegmentedToggle";
import {
  LOCAL_PLUGIN_ID,
  type LibraryNovelSummary,
  type LibrarySourceFilter,
} from "../../db/queries/novel";
import { useTranslation, type TranslationKey } from "../../i18n";
import {
  getLibrarySortDirection,
  getLibrarySortField,
  LIBRARY_DISPLAY_MODE_LABEL_KEYS,
  LIBRARY_DISPLAY_MODES,
  LIBRARY_SORT_DIRECTION_LABEL_KEYS,
  LIBRARY_SORT_FIELD_LABEL_KEYS,
  LIBRARY_SORT_FIELDS,
  toLibrarySortOrder,
  type LibrarySortDirection,
  type LibrarySortField,
} from "../../lib/library-settings-options";
import { useShallow } from "zustand/react/shallow";
import { useLibraryStore, type LibraryDisplayMode } from "../../store/library";
import { IconButton } from "../IconButton";
import { MinusIcon, PlusIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

export type TranslateFn = ReturnType<typeof useTranslation>["t"];

export type LibraryViewOptionsTab = "filter" | "sort" | "display";

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 5;

export function getLibrarySourceLabel(
  source: Pick<LibrarySourceFilter, "pluginId" | "pluginName">,
  t: TranslateFn,
): string {
  if (source.pluginId === LOCAL_PLUGIN_ID) return t("library.sources.local");
  return (
    source.pluginName?.trim() ||
    source.pluginId.trim() ||
    t("library.sources.unknown")
  );
}

type LibraryFilterFlag =
  | "unread"
  | "downloaded"
  | "local"
  | "completed"
  | "repairNeeded";

interface LibraryFilterFlagState {
  active: boolean;
  count: number;
  id: LibraryFilterFlag;
  labelKey: TranslationKey;
  set: (value: boolean) => void;
}

/** The library's boolean filters with their store state and in-scope counts. */
export function useLibraryFilterFlags(
  counts: LibraryNovelSummary,
): LibraryFilterFlagState[] {
  const store = useLibraryStore(
    useShallow((s) => ({
      completedOnlyMode: s.completedOnlyMode,
      downloadedOnlyMode: s.downloadedOnlyMode,
      localOnlyMode: s.localOnlyMode,
      repairNeededOnlyMode: s.repairNeededOnlyMode,
      setCompletedOnlyMode: s.setCompletedOnlyMode,
      setDownloadedOnlyMode: s.setDownloadedOnlyMode,
      setLocalOnlyMode: s.setLocalOnlyMode,
      setRepairNeededOnlyMode: s.setRepairNeededOnlyMode,
      setUnreadOnlyMode: s.setUnreadOnlyMode,
      unreadOnlyMode: s.unreadOnlyMode,
    })),
  );
  return [
    {
      active: store.unreadOnlyMode,
      count: counts.unreadNovels,
      id: "unread",
      labelKey: "library.filter.unread",
      set: store.setUnreadOnlyMode,
    },
    {
      active: store.downloadedOnlyMode,
      count: counts.downloadedNovels,
      id: "downloaded",
      labelKey: "library.filter.downloaded",
      set: store.setDownloadedOnlyMode,
    },
    {
      active: store.localOnlyMode,
      count: counts.localNovels,
      id: "local",
      labelKey: "library.filter.local",
      set: store.setLocalOnlyMode,
    },
    {
      active: store.completedOnlyMode,
      count: counts.completeNovels,
      id: "completed",
      labelKey: "library.filter.completed",
      set: store.setCompletedOnlyMode,
    },
    {
      active: store.repairNeededOnlyMode,
      count: counts.repairNeededNovels,
      id: "repairNeeded",
      labelKey: "library.filter.repairNeeded",
      set: store.setRepairNeededOnlyMode,
    },
  ];
}

interface LibraryViewOptionsProps {
  activeSourceId: string | null;
  counts: LibraryNovelSummary;
  onClose: () => void;
  onSourceChange: (sourceId: string | null) => void;
  onTabChange: (tab: LibraryViewOptionsTab) => void;
  opened: boolean;
  sources: readonly LibrarySourceFilter[];
  sourcesLoading: boolean;
  tab: LibraryViewOptionsTab;
}

/** Filter, sort and display choices for the library in one sheet. */
export function LibraryViewOptions({
  activeSourceId,
  counts,
  onClose,
  onSourceChange,
  onTabChange,
  opened,
  sources,
  sourcesLoading,
  tab,
}: LibraryViewOptionsProps) {
  const { t } = useTranslation();

  return (
    <ResponsiveSheet
      className="norea-library-view-options"
      onClose={onClose}
      opened={opened}
      title={t("library.viewOptions.title")}
    >
      <Tabs
        keepMounted={false}
        onChange={(value) => {
          if (value === "filter" || value === "sort" || value === "display") {
            onTabChange(value);
          }
        }}
        value={tab}
      >
        <Tabs.List grow>
          <Tabs.Tab value="filter">{t("library.viewOptions.filter")}</Tabs.Tab>
          <Tabs.Tab value="sort">{t("library.viewOptions.sort")}</Tabs.Tab>
          <Tabs.Tab value="display">{t("library.viewOptions.display")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel pt="md" value="filter">
          <FilterOptions
            activeSourceId={activeSourceId}
            counts={counts}
            onSourceChange={onSourceChange}
            sources={sources}
            sourcesLoading={sourcesLoading}
          />
        </Tabs.Panel>
        <Tabs.Panel pt="md" value="sort">
          <SortOptions />
        </Tabs.Panel>
        <Tabs.Panel pt="md" value="display">
          <DisplayOptions />
        </Tabs.Panel>
      </Tabs>
    </ResponsiveSheet>
  );
}

function FilterOptions({
  activeSourceId,
  counts,
  onSourceChange,
  sources,
  sourcesLoading,
}: Pick<
  LibraryViewOptionsProps,
  "activeSourceId" | "counts" | "onSourceChange" | "sources" | "sourcesLoading"
>) {
  const { t } = useTranslation();
  const flags = useLibraryFilterFlags(counts);

  return (
    <Stack gap="lg">
      <Stack gap="sm">
        {flags.map((flag) => (
          <Checkbox
            checked={flag.active}
            key={flag.id}
            label={
              <span className="norea-library-option-label">
                <span>{t(flag.labelKey)}</span>
                <span className="norea-library-option-count">
                  {flag.count.toLocaleString()}
                </span>
              </span>
            }
            onChange={(event) => flag.set(event.currentTarget.checked)}
          />
        ))}
      </Stack>
      {sourcesLoading || sources.length > 0 || activeSourceId !== null ? (
        <Radio.Group
          label={t("library.sources.title")}
          onChange={(value) => onSourceChange(value === "" ? null : value)}
          value={activeSourceId ?? ""}
        >
          <Stack gap="sm" mt="xs">
            <Radio label={t("library.sources.all")} value="" />
            {sourcesLoading && sources.length === 0 ? (
              <Text c="dimmed" size="sm">
                {t("library.sources.loading")}
              </Text>
            ) : null}
            {sources.map((source) => (
              <Radio
                key={source.pluginId}
                label={
                  <span className="norea-library-option-label">
                    <span>{getLibrarySourceLabel(source, t)}</span>
                    <span className="norea-library-option-count">
                      {source.totalNovels.toLocaleString()}
                    </span>
                  </span>
                }
                value={source.pluginId}
              />
            ))}
          </Stack>
        </Radio.Group>
      ) : null}
    </Stack>
  );
}

function SortOptions() {
  const { t } = useTranslation();
  const sortOrder = useLibraryStore((s) => s.sortOrder);
  const setSortOrder = useLibraryStore((s) => s.setSortOrder);
  const field = getLibrarySortField(sortOrder);
  const direction = getLibrarySortDirection(sortOrder);

  return (
    <Stack gap="lg">
      <SegmentedToggle
        aria-label={t("library.viewOptions.direction")}
        data={(["asc", "desc"] as const).map((value) => ({
          value,
          label: t(LIBRARY_SORT_DIRECTION_LABEL_KEYS[value]),
        }))}
        fullWidth
        onChange={(value) =>
          setSortOrder(toLibrarySortOrder(field, value as LibrarySortDirection))
        }
        value={direction}
      />
      <Radio.Group
        label={t("library.viewOptions.sortBy")}
        onChange={(value) =>
          setSortOrder(toLibrarySortOrder(value as LibrarySortField, direction))
        }
        value={field}
      >
        <Stack gap="sm" mt="xs">
          {LIBRARY_SORT_FIELDS.map((value) => (
            <Radio
              key={value}
              label={t(LIBRARY_SORT_FIELD_LABEL_KEYS[value])}
              value={value}
            />
          ))}
        </Stack>
      </Radio.Group>
    </Stack>
  );
}

function DisplayOptions() {
  const { t } = useTranslation();
  const displayMode = useLibraryStore((s) => s.displayMode);
  const setDisplayMode = useLibraryStore((s) => s.setDisplayMode);
  const novelsPerRow = useLibraryStore((s) => s.novelsPerRow);
  const setNovelsPerRow = useLibraryStore((s) => s.setNovelsPerRow);
  const showUnreadBadges = useLibraryStore((s) => s.showUnreadBadges);
  const setShowUnreadBadges = useLibraryStore((s) => s.setShowUnreadBadges);
  const showDownloadBadges = useLibraryStore((s) => s.showDownloadBadges);
  const setShowDownloadBadges = useLibraryStore((s) => s.setShowDownloadBadges);
  const showNumberBadges = useLibraryStore((s) => s.showNumberBadges);
  const setShowNumberBadges = useLibraryStore((s) => s.setShowNumberBadges);
  const showContinueReading = useLibraryStore((s) => s.showContinueReading);
  const setShowContinueReading = useLibraryStore((s) => s.setShowContinueReading);
  const listMode = displayMode === "list";

  return (
    <Stack gap="lg">
      <Radio.Group
        label={t("librarySettings.displayMode")}
        onChange={(value) => setDisplayMode(value as LibraryDisplayMode)}
        value={displayMode}
      >
        <Stack gap="sm" mt="xs">
          {LIBRARY_DISPLAY_MODES.map((mode) => (
            <Radio
              key={mode}
              label={t(LIBRARY_DISPLAY_MODE_LABEL_KEYS[mode])}
              value={mode}
            />
          ))}
        </Stack>
      </Radio.Group>
      <div className="norea-library-stepper-row">
        <span className="norea-library-stepper-label" id="library-columns-label">
          {t("librarySettings.novelsPerRow")}
        </span>
        <div
          aria-labelledby="library-columns-label"
          className="norea-library-stepper"
          role="group"
        >
          <IconButton
            disabled={listMode || novelsPerRow <= MIN_COLUMNS}
            label={t("library.viewOptions.fewerColumns")}
            onClick={() => setNovelsPerRow(novelsPerRow - 1)}
            size="lg"
          >
            <MinusIcon size="1.125rem" />
          </IconButton>
          <output aria-live="polite" className="norea-library-stepper-value">
            {novelsPerRow}
          </output>
          <IconButton
            disabled={listMode || novelsPerRow >= MAX_COLUMNS}
            label={t("library.viewOptions.moreColumns")}
            onClick={() => setNovelsPerRow(novelsPerRow + 1)}
            size="lg"
          >
            <PlusIcon size="1.125rem" />
          </IconButton>
        </div>
      </div>
      <Stack gap="sm">
        <Switch
          checked={showUnreadBadges}
          label={t("librarySettings.unreadBadges")}
          onChange={(event) => setShowUnreadBadges(event.currentTarget.checked)}
        />
        <Switch
          checked={showDownloadBadges}
          label={t("librarySettings.downloadedBadges")}
          onChange={(event) => setShowDownloadBadges(event.currentTarget.checked)}
        />
        <Switch
          checked={showNumberBadges}
          label={t("librarySettings.numberBadges")}
          onChange={(event) => setShowNumberBadges(event.currentTarget.checked)}
        />
        <Switch
          checked={showContinueReading}
          label={t("librarySettings.continueReading")}
          onChange={(event) => setShowContinueReading(event.currentTarget.checked)}
        />
      </Stack>
    </Stack>
  );
}
