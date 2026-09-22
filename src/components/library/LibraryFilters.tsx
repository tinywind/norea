import { Popover, ScrollArea, Tooltip, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import {
  LOCAL_PLUGIN_ID,
  type LibrarySourceFilter,
} from "../../db/queries/novel";
import { useTranslation, type TranslationKey } from "../../i18n";
import { LIBRARY_SORT_ORDERS } from "../../lib/library-settings-options";
import {
  type LibraryDisplayMode,
  type LibrarySortOrder,
} from "../../store/library";
import { DownloadedGlyph, SortGlyph } from "../ActionGlyphs";
import { IconButton } from "../IconButton";
export const SORT_LABEL_KEYS: Record<LibrarySortOrder, TranslationKey> = {
  nameAsc: "library.sort.nameAsc",
  nameDesc: "library.sort.nameDesc",
  downloadedAsc: "library.sort.downloadedAsc",
  downloadedDesc: "library.sort.downloadedDesc",
  totalChaptersAsc: "library.sort.totalChaptersAsc",
  totalChaptersDesc: "library.sort.totalChaptersDesc",
  unreadChaptersAsc: "library.sort.unreadChaptersAsc",
  unreadChaptersDesc: "library.sort.unreadChaptersDesc",
  dateAddedAsc: "library.sort.dateAddedAsc",
  dateAddedDesc: "library.sort.dateAddedDesc",
  lastReadAsc: "library.sort.lastReadAsc",
  lastReadDesc: "library.sort.lastReadDesc",
  lastUpdatedAsc: "library.sort.lastUpdatedAsc",
  lastUpdatedDesc: "library.sort.lastUpdatedDesc",
};

export type TranslateFn = ReturnType<typeof useTranslation>["t"];

interface LibrarySourceFilterBarProps {
  activeSourceId: string | null;
  loading: boolean;
  onChange: (sourceId: string | null) => void;
  sources: readonly LibrarySourceFilter[];
  t: TranslateFn;
  totalCount: number;
}

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

export function LibrarySourceFilterBar({
  activeSourceId,
  loading,
  onChange,
  sources,
  t,
  totalCount,
}: LibrarySourceFilterBarProps) {
  const allCount = loading ? "..." : totalCount.toLocaleString();

  return (
    <div
      className="norea-library-source-filter"
      aria-label={t("library.sources.title")}
    >
      <ScrollArea
        className="norea-library-source-scroll"
        offsetScrollbars
        scrollbarSize={4}
        type="hover"
      >
        <div className="norea-library-source-list">
          <UnstyledButton
            aria-pressed={activeSourceId === null}
            className="norea-library-source-chip"
            data-active={activeSourceId === null}
            onClick={() => onChange(null)}
            title={t("library.sources.all")}
          >
            <span className="norea-library-source-chip-label">
              {t("library.sources.all")}
            </span>
            <span className="norea-library-source-chip-count">{allCount}</span>
          </UnstyledButton>
          {loading && sources.length === 0 ? (
            <span className="norea-library-source-loading">
              {t("library.sources.loading")}
            </span>
          ) : null}
          {sources.map((source) => {
            const label = getLibrarySourceLabel(source, t);
            const count = source.totalNovels.toLocaleString();
            return (
              <UnstyledButton
                aria-label={`${label} ${t("library.sources.count", {
                  count: source.totalNovels,
                })}`}
                aria-pressed={activeSourceId === source.pluginId}
                className="norea-library-source-chip"
                data-active={activeSourceId === source.pluginId}
                key={source.pluginId}
                onClick={() => onChange(source.pluginId)}
                title={label}
              >
                <span className="norea-library-source-chip-label">{label}</span>
                <span className="norea-library-source-chip-count">{count}</span>
              </UnstyledButton>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

interface LibraryScopeFiltersProps {
  downloadedOnly: boolean;
  onDownloadedOnlyChange: (value: boolean) => void;
  onUnreadOnlyChange: (value: boolean) => void;
  t: TranslateFn;
  unreadOnly: boolean;
}

export function LibraryScopeFilters({
  downloadedOnly,
  onDownloadedOnlyChange,
  onUnreadOnlyChange,
  t,
  unreadOnly,
}: LibraryScopeFiltersProps) {
  return (
    <div
      className="norea-library-filter-toggle"
      role="group"
      aria-label={t("library.filters.label")}
    >
      <Tooltip label={t("library.downloadedOnly")} openDelay={350} withArrow>
        <IconButton
          active={downloadedOnly}
          aria-pressed={downloadedOnly}
          className="norea-library-filter-button"
          label={t("library.downloadedOnly")}
          onClick={() => onDownloadedOnlyChange(!downloadedOnly)}
          size="sm"
          title={t("library.downloadedOnly")}
        >
          <DownloadedGlyph />
        </IconButton>
      </Tooltip>
      <Tooltip label={t("library.unreadOnly")} openDelay={350} withArrow>
        <IconButton
          active={unreadOnly}
          aria-pressed={unreadOnly}
          className="norea-library-filter-button"
          label={t("library.unreadOnly")}
          onClick={() => onUnreadOnlyChange(!unreadOnly)}
          size="sm"
          title={t("library.unreadOnly")}
        >
          <UnreadFilterIcon />
        </IconButton>
      </Tooltip>
    </div>
  );
}

interface LibraryCommandSearchProps {
  onChange: (value: string) => void;
  value: string;
}

export function LibraryCommandSearch({
  onChange,
  value,
}: LibraryCommandSearchProps) {
  const { t } = useTranslation();

  return (
    <label className="norea-library-command-search">
      <SearchIcon />
      <input
        aria-label={t("library.search.aria")}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t("library.search.placeholder")}
        value={value}
      />
      {value.length > 0 ? (
        <button
          aria-label={t("searchBar.clear")}
          onClick={() => onChange("")}
          type="button"
        >
          x
        </button>
      ) : (
        <kbd>Ctrl K</kbd>
      )}
    </label>
  );
}

const VIEW_MODE_OPTIONS: {
  icon: "cover" | "grid" | "list" | "rows";
  labelKey: TranslationKey;
  mode: LibraryDisplayMode;
}[] = [
  { icon: "grid", labelKey: "library.viewMode.grid", mode: "comfortable" },
  { icon: "list", labelKey: "library.viewMode.list", mode: "list" },
  { icon: "rows", labelKey: "library.viewMode.compact", mode: "compact" },
  { icon: "cover", labelKey: "library.viewMode.coverOnly", mode: "cover-only" },
];

interface ViewModeToggleProps {
  displayMode: LibraryDisplayMode;
  onChange: (mode: LibraryDisplayMode) => void;
  t: TranslateFn;
}

export function ViewModeToggle({
  displayMode,
  onChange,
  t,
}: ViewModeToggleProps) {
  return (
    <div
      className="norea-library-view-toggle"
      role="group"
      aria-label={t("library.viewMode.label")}
    >
      {VIEW_MODE_OPTIONS.map((option) => {
        const label = t(option.labelKey);
        return (
          <IconButton
            active={displayMode === option.mode}
            className="norea-library-view-button"
            key={option.mode}
            label={label}
            onClick={() => onChange(option.mode)}
            size="sm"
            title={label}
          >
            <ViewModeIcon icon={option.icon} />
          </IconButton>
        );
      })}
    </div>
  );
}

export function MobileViewModePicker({
  displayMode,
  onChange,
  t,
}: ViewModeToggleProps) {
  const activeOption =
    VIEW_MODE_OPTIONS.find((option) => option.mode === displayMode) ??
    VIEW_MODE_OPTIONS[0];
  const activeLabel = t(activeOption.labelKey);

  return (
    <Popover position="bottom-end" shadow="md" width={180}>
      <Popover.Target>
        <IconButton
          className="norea-library-mobile-view-button"
          label={t("library.viewMode.label")}
          size="sm"
          title={activeLabel}
        >
          <ViewModeIcon icon={activeOption.icon} />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="norea-library-mobile-view-menu">
        {VIEW_MODE_OPTIONS.map((option) => {
          const label = t(option.labelKey);
          return (
            <UnstyledButton
              className="norea-library-mobile-view-option"
              data-active={displayMode === option.mode}
              key={option.mode}
              onClick={() => onChange(option.mode)}
            >
              <ViewModeIcon icon={option.icon} />
              <span>{label}</span>
            </UnstyledButton>
          );
        })}
      </Popover.Dropdown>
    </Popover>
  );
}

interface LibrarySortPickerProps {
  onChange: (sortOrder: LibrarySortOrder) => void;
  sortOrder: LibrarySortOrder;
  t: TranslateFn;
}

export function LibrarySortPicker({
  onChange,
  sortOrder,
  t,
}: LibrarySortPickerProps) {
  const [opened, setOpened] = useState(false);
  const activeLabel = t(SORT_LABEL_KEYS[sortOrder]);
  const sortDirection = sortOrder.endsWith("Asc") ? "asc" : "desc";

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      width={220}
    >
      <Popover.Target>
        <IconButton
          active={opened}
          className="norea-library-icon-button norea-library-sort-button"
          data-sort-direction={sortDirection}
          label={t("librarySettings.sort")}
          onClick={() => setOpened((current) => !current)}
          size="sm"
          title={activeLabel}
        >
          <SortGlyph />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="norea-library-sort-menu">
        {LIBRARY_SORT_ORDERS.map((value) => {
          const label = t(SORT_LABEL_KEYS[value]);
          return (
            <UnstyledButton
              className="norea-library-sort-option"
              data-active={sortOrder === value}
              key={value}
              onClick={() => {
                onChange(value);
                setOpened(false);
              }}
            >
              <span>{label}</span>
            </UnstyledButton>
          );
        })}
      </Popover.Dropdown>
    </Popover>
  );
}

export function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function SlidersIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <path d="M4 17h2" />
      <path d="M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  );
}

function UnreadFilterIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5h14v14H5z" />
      <path d="M8 10h6" />
      <path d="M8 14h5" />
      <circle cx="17" cy="7" r="2" />
    </svg>
  );
}

function ViewModeIcon({ icon }: { icon: "cover" | "grid" | "list" | "rows" }) {
  switch (icon) {
    case "grid":
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 4h7v7H4z" />
          <path d="M13 4h7v7h-7z" />
          <path d="M4 13h7v7H4z" />
          <path d="M13 13h7v7h-7z" />
        </svg>
      );
    case "list":
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M8 6h12" />
          <path d="M8 12h12" />
          <path d="M8 18h12" />
          <path d="M4 6h.01" />
          <path d="M4 12h.01" />
          <path d="M4 18h.01" />
        </svg>
      );
    case "rows":
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 5h16v4H4z" />
          <path d="M4 15h16v4H4z" />
        </svg>
      );
    case "cover":
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M7 4h10v16H7z" />
          <path d="M10 7h4" />
          <path d="M10 17h4" />
        </svg>
      );
  }
}
