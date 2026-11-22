import {
  Checkbox,
  Radio,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useId, useMemo, useState } from "react";
import { SegmentedToggle } from "../SegmentedToggle";
import { ChipButton } from "../ChipButton";
import {
  LOCAL_PLUGIN_ID,
  type LibraryNovelSummary,
  type LibrarySourceFilter,
  type LibraryStatusFilter,
  type LibraryTagFilter,
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
import { CANONICAL_NOVEL_STATUSES, canonicalNovelStatusLabel } from "../novel/novel-detail-model";
import { IconButton } from "../IconButton";
import { CloseIcon, MinusIcon, PlusIcon } from "../ui/icons";
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
  statuses?: readonly LibraryStatusFilter[];
  statusesLoading?: boolean;
  tab: LibraryViewOptionsTab;
  tags?: readonly LibraryTagFilter[];
  tagsLoading?: boolean;
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
  statuses = [],
  statusesLoading = false,
  tab,
  tags = [],
  tagsLoading = false,
}: LibraryViewOptionsProps) {
  const { t } = useTranslation();

  return (
    <ResponsiveSheet
      className="norea-library-view-options norea-sheet--tabbed"
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
            statuses={statuses}
            statusesLoading={statusesLoading}
            tags={tags}
            tagsLoading={tagsLoading}
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

export function FilterOptions({
  activeSourceId,
  counts,
  onSourceChange,
  sources,
  sourcesLoading,
  statuses = [],
  statusesLoading = false,
  tags = [],
  tagsLoading = false,
}: Pick<
  LibraryViewOptionsProps,
  | "activeSourceId"
  | "counts"
  | "onSourceChange"
  | "sources"
  | "sourcesLoading"
  | "statuses"
  | "statusesLoading"
  | "tags"
  | "tagsLoading"
>) {
  const { t } = useTranslation();
  const flags = useLibraryFilterFlags(counts);
  const {
    selectedStatuses,
    selectedTags,
    setSelectedStatuses,
    toggleTag,
  } = useLibraryStore(
    useShallow((s) => ({
      selectedStatuses: s.selectedStatuses,
      selectedTags: s.selectedTags,
      setSelectedStatuses: s.setSelectedStatuses,
      toggleTag: s.toggleTag,
    })),
  );
  const [tagSearch, setTagSearch] = useState("");
  const tagHeadingId = useId();

  const statusOptions = useMemo(() => {
    const countsByStatus = new Map(
      statuses.map((entry) => [entry.status, entry.totalNovels]),
    );
    const ordered: string[] = [];
    for (const status of CANONICAL_NOVEL_STATUSES) {
      if ((countsByStatus.get(status) ?? 0) > 0 || selectedStatuses.includes(status)) {
        ordered.push(status);
      }
    }
    for (const entry of statuses) {
      if (!ordered.includes(entry.status)) ordered.push(entry.status);
    }
    for (const selected of selectedStatuses) {
      if (!ordered.includes(selected)) ordered.push(selected);
    }
    return ordered.map((status) => ({
      status,
      totalNovels: countsByStatus.get(status) ?? 0,
    }));
  }, [selectedStatuses, statuses]);

  const mergedTagOptions = useMemo(() => {
    const byKey = new Map<string, LibraryTagFilter>();
    for (const entry of tags) {
      byKey.set(entry.tag.toLowerCase(), entry);
    }
    const items: LibraryTagFilter[] = [];
    const seen = new Set<string>();
    for (const selected of selectedTags) {
      const key = selected.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const found = byKey.get(key);
      items.push({
        tag: found?.tag ?? selected,
        totalNovels: found?.totalNovels ?? 0,
      });
    }
    for (const entry of tags) {
      const key = entry.tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(entry);
    }
    const needle = tagSearch.trim().toLowerCase();
    return needle
      ? items.filter((entry) => entry.tag.toLowerCase().includes(needle))
      : items;
  }, [selectedTags, tagSearch, tags]);

  const selectedTagKeys = useMemo(
    () => new Set(selectedTags.map((tag) => tag.toLowerCase())),
    [selectedTags],
  );

  return (
    <Stack gap="lg">
      <div className="norea-library-option-list norea-library-filter-grid">
        {flags.map((flag) => (
          <Checkbox
            checked={flag.active}
            key={flag.id}
            label={
              <span className="norea-library-option-label">
                <span className="norea-library-option-text">{t(flag.labelKey)}</span>
                <span className="norea-library-option-count">
                  {flag.count.toLocaleString()}
                </span>
              </span>
            }
            onChange={(event) => flag.set(event.currentTarget.checked)}
          />
        ))}
      </div>
      {statusesLoading || statusOptions.length > 0 || selectedStatuses.length > 0 ? (
        <Checkbox.Group
          label={t("library.statusFilters.title")}
          onChange={(values) => setSelectedStatuses(values)}
          value={selectedStatuses}
        >
          <div className="norea-library-option-list norea-library-filter-grid">
            {statusesLoading && statusOptions.length === 0 ? (
              <Text c="dimmed" className="norea-library-filter-grid-message" size="sm">
                {t("library.statusFilters.loading")}
              </Text>
            ) : null}
            {statusOptions.map((option) => (
              <Checkbox
                key={option.status}
                label={
                  <span className="norea-library-option-label">
                    <span className="norea-library-option-text">
                      {canonicalNovelStatusLabel(option.status, t)}
                    </span>
                    <span className="norea-library-option-count">
                      {option.totalNovels.toLocaleString()}
                    </span>
                  </span>
                }
                value={option.status}
              />
            ))}
          </div>
        </Checkbox.Group>
      ) : null}
      {sourcesLoading || sources.length > 0 || activeSourceId !== null ? (
        <Radio.Group
          label={t("library.sources.title")}
          onChange={(value) => onSourceChange(value === "" ? null : value)}
          value={activeSourceId ?? ""}
        >
          <div className="norea-library-option-list norea-library-filter-grid">
            <Radio
              label={
                <span className="norea-library-option-label">
                  <span className="norea-library-option-text">
                    {t("library.sources.all")}
                  </span>
                </span>
              }
              value=""
            />
            {sourcesLoading && sources.length === 0 ? (
              <Text c="dimmed" className="norea-library-filter-grid-message" size="sm">
                {t("library.sources.loading")}
              </Text>
            ) : null}
            {sources.map((source) => (
              <Radio
                key={source.pluginId}
                label={
                  <span className="norea-library-option-label">
                    <span className="norea-library-option-text">
                      {getLibrarySourceLabel(source, t)}
                    </span>
                    <span className="norea-library-option-count">
                      {source.totalNovels.toLocaleString()}
                    </span>
                  </span>
                }
                value={source.pluginId}
              />
            ))}
          </div>
        </Radio.Group>
      ) : null}
      {tagsLoading || tags.length > 0 || selectedTags.length > 0 ? (
        <div aria-labelledby={tagHeadingId} role="group">
          <span className="norea-library-option-group-label" id={tagHeadingId}>
            {t("library.tagFilters.title")}
          </span>
          {selectedTags.length > 0 ? (
            <div className="norea-library-tag-selected">
              {selectedTags.map((tag) => (
                <ChipButton
                  className="norea-library-chip"
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  selected
                >
                  {tag}
                </ChipButton>
              ))}
            </div>
          ) : null}
          <TextInput
            aria-label={t("library.tagFilters.search")}
            className="norea-library-tag-search"
            onChange={(event) => setTagSearch(event.currentTarget.value)}
            placeholder={t("library.tagFilters.searchPlaceholder")}
            rightSection={
              tagSearch ? (
                <IconButton
                  label={t("common.clear")}
                  onClick={() => setTagSearch("")}
                  size="sm"
                >
                  <CloseIcon size="0.875rem" />
                </IconButton>
              ) : undefined
            }
            size="sm"
            value={tagSearch}
          />
          <div className="norea-library-option-list norea-library-filter-grid norea-library-tag-list">
            {tagsLoading && mergedTagOptions.length === 0 ? (
              <Text c="dimmed" className="norea-library-filter-grid-message" size="sm">
                {t("library.tagFilters.loading")}
              </Text>
            ) : null}
            {!tagsLoading && mergedTagOptions.length === 0 && tagSearch.trim() !== "" ? (
              <Text c="dimmed" className="norea-library-filter-grid-message" size="sm">
                {t("library.tagFilters.emptySearch")}
              </Text>
            ) : null}
            {mergedTagOptions.map((entry) => {
              const checked = selectedTagKeys.has(entry.tag.toLowerCase());
              return (
                <Checkbox
                  checked={checked}
                  key={entry.tag}
                  label={
                    <span className="norea-library-option-label">
                      <span className="norea-library-option-text">{entry.tag}</span>
                      <span className="norea-library-option-count">
                        {entry.totalNovels.toLocaleString()}
                      </span>
                    </span>
                  }
                  onChange={() => toggleTag(entry.tag)}
                />
              );
            })}
          </div>
        </div>
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
        <Stack className="norea-library-option-list" gap={0}>
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
        <Stack className="norea-library-option-list" gap={0}>
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
      <Stack className="norea-library-option-list" gap={0}>
        <Switch
          checked={showUnreadBadges}
          labelPosition="left"
          label={t("librarySettings.unreadBadges")}
          onChange={(event) => setShowUnreadBadges(event.currentTarget.checked)}
        />
        <Switch
          checked={showDownloadBadges}
          labelPosition="left"
          label={t("librarySettings.downloadedBadges")}
          onChange={(event) => setShowDownloadBadges(event.currentTarget.checked)}
        />
        <Switch
          checked={showNumberBadges}
          labelPosition="left"
          label={t("librarySettings.numberBadges")}
          onChange={(event) => setShowNumberBadges(event.currentTarget.checked)}
        />
        <Switch
          checked={showContinueReading}
          labelPosition="left"
          label={t("librarySettings.continueReading")}
          onChange={(event) => setShowContinueReading(event.currentTarget.checked)}
        />
      </Stack>
    </Stack>
  );
}
