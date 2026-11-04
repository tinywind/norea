import { Group, Select, Stack } from "@mantine/core";
import { SegmentedToggle } from "./SegmentedToggle";
import { useQuery } from "@tanstack/react-query";
import { listCategories, UNCATEGORIZED_CATEGORY_ID } from "../db/queries/category";
import { SettingsFieldRow, SettingsSection } from "./SettingsPrimitives";
import { useTranslation } from "../i18n";
import {
  DEFAULT_CHAPTER_SORT_LABEL_KEYS,
  DEFAULT_CHAPTER_SORT_ORDERS,
  getLibrarySortDirection,
  getLibrarySortField,
  LIBRARY_SORT_DIRECTION_LABEL_KEYS,
  LIBRARY_SORT_FIELD_LABEL_KEYS,
  LIBRARY_SORT_FIELDS,
  toLibrarySortOrder,
  type LibrarySortDirection,
  type LibrarySortField,
} from "../lib/library-settings-options";
import {
  CHECK_INTERVAL_CHOICES,
  normalizeCheckIntervalHours,
  useLibraryStore,
  type DefaultChapterSort,
} from "../store/library";

export function LibrarySettingsPanel() {
  const { t } = useTranslation();
  const defaultCategoryId = useLibraryStore((s) => s.defaultCategoryId);
  const setDefaultCategoryId = useLibraryStore((s) => s.setDefaultCategoryId);
  const categories = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["category", "list"],
    queryFn: () => listCategories(),
    staleTime: Infinity,
  });
  const sortOrder = useLibraryStore((s) => s.sortOrder);
  const setSortOrder = useLibraryStore((s) => s.setSortOrder);
  const defaultChapterSort = useLibraryStore((s) => s.defaultChapterSort);
  const setDefaultChapterSort = useLibraryStore(
    (s) => s.setDefaultChapterSort,
  );
  const checkIntervalHours = useLibraryStore((s) => normalizeCheckIntervalHours(s.checkIntervalHours));
  const setCheckIntervalHours = useLibraryStore((s) => s.setCheckIntervalHours);

  return (
    <Stack gap="md">
      <SettingsSection title={t("librarySettings.group.defaults")}>
        <SettingsFieldRow
          label={t("librarySettings.defaultCategory")}
          description={t("librarySettings.defaultCategory.description")}
        >
          <Select
            aria-label={t("librarySettings.defaultCategory")}
            data={[
              { value: "all", label: t("categories.all") },
              { value: String(UNCATEGORIZED_CATEGORY_ID), label: t("categories.uncategorized") },
              ...(categories.data ?? []).map((category) => ({
                value: String(category.id),
                label: category.name,
              })),
            ]}
            disabled={categories.isLoading || categories.isError}
            error={categories.isError ? t("librarySettings.defaultCategory.error") : undefined}
            value={defaultCategoryId === null ? "all" : String(defaultCategoryId)}
            onChange={(value) => {
              if (value !== null) setDefaultCategoryId(value === "all" ? null : Number(value));
            }}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("librarySettings.sort")}
          description={t("librarySettings.sort.description")}
        >
          <Group gap="xs" wrap="wrap">
            <Select
              aria-label={t("library.viewOptions.sortBy")}
              data={LIBRARY_SORT_FIELDS.map((value) => ({
                value,
                label: t(LIBRARY_SORT_FIELD_LABEL_KEYS[value]),
              }))}
              value={getLibrarySortField(sortOrder)}
              onChange={(value) => {
                if (value) {
                  setSortOrder(
                    toLibrarySortOrder(
                      value as LibrarySortField,
                      getLibrarySortDirection(sortOrder),
                    ),
                  );
                }
              }}
            />
            <SegmentedToggle
              aria-label={t("library.viewOptions.direction")}
              data={(["asc", "desc"] as const).map((value) => ({
                value,
                label: t(LIBRARY_SORT_DIRECTION_LABEL_KEYS[value]),
              }))}
              value={getLibrarySortDirection(sortOrder)}
              onChange={(value) =>
                setSortOrder(
                  toLibrarySortOrder(
                    getLibrarySortField(sortOrder),
                    value as LibrarySortDirection,
                  ),
                )
              }
            />
          </Group>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("librarySettings.defaultChapterSort")}
          description={t("librarySettings.defaultChapterSort.description")}
        >
          <Select
            data={DEFAULT_CHAPTER_SORT_ORDERS.map((value) => ({
              value,
              label: t(DEFAULT_CHAPTER_SORT_LABEL_KEYS[value]),
            }))}
            value={defaultChapterSort}
            onChange={(value) => {
              if (value) setDefaultChapterSort(value as DefaultChapterSort);
            }}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t("librarySettings.group.updates")}>
        <SettingsFieldRow
          label={t("librarySettings.checkInterval")}
          description={t("librarySettings.checkInterval.description")}
        >
          <Select
            allowDeselect={false}
            data={CHECK_INTERVAL_CHOICES.map((hours) => ({
              value: String(hours),
              label: hours === 0
                ? t("librarySettings.checkInterval.off")
                : t("librarySettings.checkInterval.hours", { count: hours }),
            }))}
            value={String(checkIntervalHours)}
            onChange={(value) => {
              if (value !== null) setCheckIntervalHours(Number(value));
            }}
          />
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}
