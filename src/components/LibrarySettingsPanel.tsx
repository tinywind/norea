import { NumberInput, Select, Stack, Switch } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { listCategories, UNCATEGORIZED_CATEGORY_ID } from "../db/queries/category";
import { SegmentedToggle } from "./SegmentedToggle";
import { SettingsFieldRow, SettingsSection } from "./SettingsPrimitives";
import { useTranslation } from "../i18n";
import {
  DEFAULT_CHAPTER_SORT_LABEL_KEYS,
  DEFAULT_CHAPTER_SORT_ORDERS,
  LIBRARY_DISPLAY_MODE_LABEL_KEYS,
  LIBRARY_DISPLAY_MODES,
  LIBRARY_SORT_ORDER_LABEL_KEYS,
  LIBRARY_SORT_ORDERS,
} from "../lib/library-settings-options";
import {
  useLibraryStore,
  type DefaultChapterSort,
  type LibraryDisplayMode,
  type LibrarySortOrder,
} from "../store/library";

export function LibrarySettingsPanel() {
  const { t } = useTranslation();
  const defaultCategoryId = useLibraryStore((s) => s.defaultCategoryId);
  const setDefaultCategoryId = useLibraryStore((s) => s.setDefaultCategoryId);
  const categories = useQuery({
    queryKey: ["category", "list"],
    queryFn: listCategories,
    staleTime: Infinity,
  });
  const displayMode = useLibraryStore((s) => s.displayMode);
  const setDisplayMode = useLibraryStore((s) => s.setDisplayMode);
  const novelsPerRow = useLibraryStore((s) => s.novelsPerRow);
  const setNovelsPerRow = useLibraryStore((s) => s.setNovelsPerRow);
  const sortOrder = useLibraryStore((s) => s.sortOrder);
  const setSortOrder = useLibraryStore((s) => s.setSortOrder);
  const showDownloadBadges = useLibraryStore((s) => s.showDownloadBadges);
  const setShowDownloadBadges = useLibraryStore(
    (s) => s.setShowDownloadBadges,
  );
  const showUnreadBadges = useLibraryStore((s) => s.showUnreadBadges);
  const setShowUnreadBadges = useLibraryStore((s) => s.setShowUnreadBadges);
  const showNumberBadges = useLibraryStore((s) => s.showNumberBadges);
  const setShowNumberBadges = useLibraryStore((s) => s.setShowNumberBadges);
  const incognitoMode = useLibraryStore((s) => s.incognitoMode);
  const setIncognitoMode = useLibraryStore((s) => s.setIncognitoMode);
  const defaultChapterSort = useLibraryStore((s) => s.defaultChapterSort);
  const setDefaultChapterSort = useLibraryStore(
    (s) => s.setDefaultChapterSort,
  );

  return (
    <Stack gap="md">
      <SettingsSection title={t("librarySettings.group.sorting")}>
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
          <Select
            data={LIBRARY_SORT_ORDERS.map((value) => ({
              value,
              label: t(LIBRARY_SORT_ORDER_LABEL_KEYS[value]),
            }))}
            value={sortOrder}
            onChange={(value) => {
              if (value) setSortOrder(value as LibrarySortOrder);
            }}
          />
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

      <SettingsSection title={t("librarySettings.group.layout")}>
        <SettingsFieldRow
          label={t("librarySettings.displayMode")}
          description={t("librarySettings.displayMode.description")}
        >
          <SegmentedToggle
            data={LIBRARY_DISPLAY_MODES.map((value) => ({
              value,
              label: t(LIBRARY_DISPLAY_MODE_LABEL_KEYS[value]),
            }))}
            value={displayMode}
            onChange={(value) => setDisplayMode(value as LibraryDisplayMode)}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("librarySettings.novelsPerRow")}
          description={t("librarySettings.novelsPerRow.description")}
        >
          <NumberInput
            min={1}
            max={5}
            value={novelsPerRow}
            onChange={(value) => {
              if (typeof value === "number") setNovelsPerRow(value);
            }}
            disabled={displayMode === "list"}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t("librarySettings.group.badges")}>
        <SettingsFieldRow
          label={t("librarySettings.downloadedBadges")}
          description={t("librarySettings.downloadedBadges.description")}
        >
          <Switch
            checked={showDownloadBadges}
            onChange={(event) =>
              setShowDownloadBadges(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("librarySettings.unreadBadges")}
          description={t("librarySettings.unreadBadges.description")}
        >
          <Switch
            checked={showUnreadBadges}
            onChange={(event) =>
              setShowUnreadBadges(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("librarySettings.numberBadges")}
          description={t("librarySettings.numberBadges.description")}
        >
          <Switch
            checked={showNumberBadges}
            onChange={(event) =>
              setShowNumberBadges(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t("librarySettings.group.privacy")}>
        <SettingsFieldRow
          label={t("librarySettings.incognito")}
          description={t("librarySettings.incognito.description")}
        >
          <Switch
            checked={incognitoMode}
            onChange={(event) =>
              setIncognitoMode(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}
