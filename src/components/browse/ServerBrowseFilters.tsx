import { useId, useMemo, useState } from "react";
import { Checkbox, Radio, Stack, Text, TextInput } from "@mantine/core";
import { useTranslation } from "../../i18n";
import type {
  ServerCategorySummary,
  ServerSourceSummary,
  ServerStatusSummary,
  ServerTagSummary,
  ServerWorkFilter,
} from "../../lib/content-sync/browse";
import {
  NovelStatus,
  isNovelStatus,
  normalizeNovelStatus,
  type NovelStatusValue,
} from "../../lib/plugins/types";
import { ChipButton } from "../ChipButton";
import { IconButton } from "../IconButton";
import { CANONICAL_NOVEL_STATUSES, canonicalNovelStatusLabel } from "../novel/novel-detail-model";
import { CloseIcon, FilterIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import "../../styles/library.css";

const QUICK_STATUSES: readonly NovelStatusValue[] = [
  NovelStatus.Ongoing,
  NovelStatus.Completed,
];

/** Sentinel checkbox value for uncategorized works; real user-state category IDs forbid `$`. */
const UNCATEGORIZED_VALUE = "$uncategorized";

export type ServerBrowseFilterSelection = Omit<ServerWorkFilter, "query">;

interface ServerBrowseFiltersProps {
  categories: readonly ServerCategorySummary[];
  filter: ServerBrowseFilterSelection;
  filtersLoading: boolean;
  onChange: (filter: Partial<ServerBrowseFilterSelection>) => void;
  sourceName: (id: string) => string;
  sources: readonly ServerSourceSummary[];
  statuses: readonly ServerStatusSummary[];
  tags: readonly ServerTagSummary[];
  uncategorizedCount: number;
}

/**
 * The server browse filters aligned with the library's filter chips and sheet:
 * quick status chips, active category/status/tag chips, multi-column bordered
 * filter grids for categories, canonical publication statuses, sources, and searchable tags.
 */
export function ServerBrowseFilters({
  categories,
  filter,
  filtersLoading,
  onChange,
  sourceName,
  sources,
  statuses,
  tags,
  uncategorizedCount,
}: ServerBrowseFiltersProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const tagHeadingId = useId();
  const {
    categories: selectedCategories,
    source,
    statuses: selectedStatuses,
    tags: selectedTags,
    uncategorized,
  } = filter;

  const activeCount =
    selectedCategories.length +
    (uncategorized ? 1 : 0) +
    selectedStatuses.length +
    (source ? 1 : 0) +
    selectedTags.length;

  const categoryNameById = useMemo(
    () => new Map(categories.map((entry) => [entry.id, entry.name])),
    [categories],
  );

  const categoryOptions = useMemo(() => {
    const items: Array<{ id: string; name: string; workCount: number }> = categories.map(
      (entry) => ({ id: entry.id, name: entry.name, workCount: entry.workCount }),
    );
    const seen = new Set(items.map((item) => item.id));
    for (const id of selectedCategories) {
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, name: id, workCount: 0 });
    }
    if (uncategorizedCount > 0 || uncategorized) {
      items.push({
        id: UNCATEGORIZED_VALUE,
        name: t("categories.uncategorized"),
        workCount: uncategorizedCount,
      });
    }
    return items;
  }, [categories, selectedCategories, t, uncategorized, uncategorizedCount]);

  const selectedCategoryValues = useMemo(
    () => (uncategorized ? [...selectedCategories, UNCATEGORIZED_VALUE] : [...selectedCategories]),
    [selectedCategories, uncategorized],
  );

  const statusOptions = useMemo(() => {
    const countsByStatus = new Map<NovelStatusValue, number>();
    for (const entry of statuses) {
      const canonical = normalizeNovelStatus(entry.status);
      countsByStatus.set(
        canonical,
        (countsByStatus.get(canonical) ?? 0) + entry.workCount,
      );
    }
    const ordered: NovelStatusValue[] = [];
    for (const status of CANONICAL_NOVEL_STATUSES) {
      if ((countsByStatus.get(status) ?? 0) > 0 || selectedStatuses.includes(status)) {
        ordered.push(status);
      }
    }
    return ordered.map((status) => ({
      status,
      workCount: countsByStatus.get(status) ?? 0,
    }));
  }, [selectedStatuses, statuses]);

  const sourceOptions = useMemo(() => {
    const items = [...sources];
    if (source && !items.some((entry) => entry.id === source)) {
      items.push({ id: source, workCount: 0 });
    }
    return items;
  }, [source, sources]);

  const mergedTagOptions = useMemo(() => {
    const byKey = new Map<string, ServerTagSummary>();
    for (const entry of tags) {
      byKey.set(entry.tag.toLowerCase(), entry);
    }
    const items: ServerTagSummary[] = [];
    const seen = new Set<string>();
    for (const selected of selectedTags) {
      const key = selected.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const found = byKey.get(key);
      items.push({
        tag: found?.tag ?? selected,
        workCount: found?.workCount ?? 0,
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

  const toggleStatus = (status: NovelStatusValue) => {
    const next = selectedStatuses.includes(status)
      ? selectedStatuses.filter((item) => item !== status)
      : [...selectedStatuses, status];
    onChange({ statuses: next });
  };

  const toggleCategory = (categoryId: string) => {
    const next = selectedCategories.includes(categoryId)
      ? selectedCategories.filter((item) => item !== categoryId)
      : [...selectedCategories, categoryId];
    onChange({ categories: next });
  };

  const toggleTag = (tag: string) => {
    const key = tag.toLowerCase();
    const next = selectedTagKeys.has(key)
      ? selectedTags.filter((item) => item.toLowerCase() !== key)
      : [...selectedTags, tag];
    onChange({ tags: next });
  };

  const extraSelectedStatuses = selectedStatuses.filter(
    (status) => !QUICK_STATUSES.includes(status),
  );

  return (
    <div className="norea-library-filter-row norea-server-filter-row">
      <div aria-label={t("contentSync.filters.label")} className="norea-library-chips" role="group">
        {QUICK_STATUSES.map((status) => (
          <ChipButton
            className="norea-library-chip"
            key={`status:${status}`}
            onClick={() => toggleStatus(status)}
            selected={selectedStatuses.includes(status)}
          >
            {canonicalNovelStatusLabel(status, t)}
          </ChipButton>
        ))}
        {extraSelectedStatuses.map((status) => (
          <ChipButton
            className="norea-library-chip"
            key={`status:${status}`}
            onClick={() => toggleStatus(status)}
            selected
          >
            {canonicalNovelStatusLabel(status, t)}
          </ChipButton>
        ))}
        {selectedCategories.map((categoryId) => (
          <ChipButton
            className="norea-library-chip"
            key={`category:${categoryId}`}
            onClick={() => toggleCategory(categoryId)}
            selected
          >
            {categoryNameById.get(categoryId) ?? categoryId}
          </ChipButton>
        ))}
        {uncategorized ? (
          <ChipButton
            className="norea-library-chip"
            key="category:uncategorized"
            onClick={() => onChange({ uncategorized: false })}
            selected
          >
            {t("categories.uncategorized")}
          </ChipButton>
        ) : null}
        {selectedTags.map((tag) => (
          <ChipButton
            className="norea-library-chip"
            key={`tag:${tag}`}
            onClick={() => toggleTag(tag)}
            selected
          >
            {tag}
          </ChipButton>
        ))}
        <ChipButton
          className="norea-library-chip"
          icon={<FilterIcon />}
          onClick={() => setOpened(true)}
          tone={activeCount > 0 ? "accent" : undefined}
        >
          {activeCount > 0
            ? t("contentSync.filters.moreActive", { count: activeCount })
            : t("contentSync.filters.more")}
        </ChipButton>
        {activeCount > 0 ? (
          <ChipButton
            className="norea-library-chip"
            onClick={() =>
              onChange({
                categories: [],
                source: "",
                statuses: [],
                tags: [],
                uncategorized: false,
              })
            }
          >
            {t("common.clear")}
          </ChipButton>
        ) : null}
      </div>
      <ResponsiveSheet
        className="norea-library-view-options"
        onClose={() => setOpened(false)}
        opened={opened}
        title={t("contentSync.filters.title")}
      >
        <Stack gap="lg">
          {filtersLoading || categoryOptions.length > 0 ? (
            <Checkbox.Group
              label={t("categories.title")}
              onChange={(values) => {
                const nextUncategorized = values.includes(UNCATEGORIZED_VALUE);
                const nextCategories = values.filter((value) => value !== UNCATEGORIZED_VALUE);
                onChange({ categories: nextCategories, uncategorized: nextUncategorized });
              }}
              value={selectedCategoryValues}
            >
              <div className="norea-library-option-list norea-library-filter-grid">
                {filtersLoading && categoryOptions.length === 0 ? (
                  <Text c="dimmed" className="norea-library-filter-grid-message" size="sm">
                    {t("contentSync.filters.categoriesLoading")}
                  </Text>
                ) : null}
                {categoryOptions.map((option) => (
                  <Checkbox
                    key={option.id}
                    label={
                      <span className="norea-library-option-label">
                        <span className="norea-library-option-text">{option.name}</span>
                        <span className="norea-library-option-count">
                          {option.workCount.toLocaleString()}
                        </span>
                      </span>
                    }
                    value={option.id}
                  />
                ))}
              </div>
            </Checkbox.Group>
          ) : null}
          {filtersLoading || statusOptions.length > 0 || selectedStatuses.length > 0 ? (
            <Checkbox.Group
              label={t("library.statusFilters.title")}
              onChange={(values) =>
                onChange({ statuses: values.filter(isNovelStatus) })
              }
              value={[...selectedStatuses]}
            >
              <div className="norea-library-option-list norea-library-filter-grid">
                {filtersLoading && statusOptions.length === 0 ? (
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
                          {option.workCount.toLocaleString()}
                        </span>
                      </span>
                    }
                    value={option.status}
                  />
                ))}
              </div>
            </Checkbox.Group>
          ) : null}
          {filtersLoading || sourceOptions.length > 0 || source !== "" ? (
            <Radio.Group
              label={t("library.sources.title")}
              onChange={(value) => onChange({ source: value })}
              value={source}
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
                {filtersLoading && sourceOptions.length === 0 ? (
                  <Text c="dimmed" className="norea-library-filter-grid-message" size="sm">
                    {t("library.sources.loading")}
                  </Text>
                ) : null}
                {sourceOptions.map((item) => (
                  <Radio
                    key={item.id}
                    label={
                      <span className="norea-library-option-label">
                        <span className="norea-library-option-text">
                          {sourceName(item.id)}
                        </span>
                        <span className="norea-library-option-count">
                          {item.workCount.toLocaleString()}
                        </span>
                      </span>
                    }
                    value={item.id}
                  />
                ))}
              </div>
            </Radio.Group>
          ) : null}
          {filtersLoading || tags.length > 0 || selectedTags.length > 0 ? (
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
                {filtersLoading && mergedTagOptions.length === 0 ? (
                  <Text c="dimmed" className="norea-library-filter-grid-message" size="sm">
                    {t("library.tagFilters.loading")}
                  </Text>
                ) : null}
                {!filtersLoading && mergedTagOptions.length === 0 && tagSearch.trim() !== "" ? (
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
                            {entry.workCount.toLocaleString()}
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
      </ResponsiveSheet>
    </div>
  );
}
