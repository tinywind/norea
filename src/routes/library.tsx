import { Loader, Text, UnstyledButton } from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckGlyph,
  DownloadedGlyph,
  PlusGlyph,
  TrashGlyph,
} from "../components/ActionGlyphs";
import { PageFrame, StateView } from "../components/AppFrame";
import { CategoriesDrawer } from "../components/CategoriesDrawer";
import { IconButton } from "../components/IconButton";
import { LibraryBatchDownloadPicker } from "../components/library/LibraryBatchDownloadPicker";
import {
  CategorySubpanel,
  SelectionCategoryPicker,
} from "../components/library/LibraryCategories";
import { LibraryAppBar } from "../components/library/LibraryAppBar";
import {
  LibraryCategoryDialogs,
  type LibraryCategoryDialogsHandle,
} from "../components/library/LibraryCategoryDialogs";
import {
  LibraryViewOptions,
  type LibraryViewOptionsTab,
} from "../components/library/LibraryViewOptions";
import { LibraryQuickFilters } from "../components/library/LibraryQuickFilters";
import {
  LibraryLocalImport,
  type LibraryLocalImportHandle,
} from "../components/library/LibraryLocalImport";
import { useLibraryQuery } from "../components/library/use-library-query";
import { useLibraryEntry } from "../components/library/use-library-entry";
import { StorageRecoveryStatus } from "../components/runtime/StorageRecovery";
import { useLibrarySelection } from "../components/library/use-library-selection";
import { LibraryGrid } from "../components/LibraryGrid";
import { TextButton } from "../components/TextButton";
import {
  UNCATEGORIZED_CATEGORY_ID,
  type LibraryCategory,
} from "../db/queries/category";
import { type LibraryNovelRefreshFilter } from "../db/queries/novel";
import {
  CategoryIcon,
  FolderIcon,
  ImportIcon,
  RefreshIcon,
  SettingsIcon,
} from "../components/ui/icons";
import type { OverflowMenuItem } from "../components/ui/OverflowMenu";
import { useTranslation } from "../i18n";
import { showErrorToast } from "../lib/runtime/error-toast";
import { refreshLibraryMetadata } from "../lib/updates/refresh-library-metadata";
import { useLibraryStore } from "../store/library";
import "../styles/library.css";

const SEARCH_DEBOUNCE_MS = 200;
interface LibraryPageProps {
  active?: boolean;
}

export function LibraryPage({ active = true }: LibraryPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const localImportRef = useRef<LibraryLocalImportHandle>(null);
  const categoryDialogsRef = useRef<LibraryCategoryDialogsHandle>(null);
  const openLocalImportInput = useCallback(
    () => localImportRef.current?.openFilePicker(),
    [],
  );
  const openLocalHome = useCallback(
    () => localImportRef.current?.openLocalHome(),
    [],
  );
  const openCreateCategory = useCallback(
    () => categoryDialogsRef.current?.createCategory(),
    [],
  );
  const openRenameCategory = useCallback(
    (category: LibraryCategory) =>
      categoryDialogsRef.current?.renameCategory(category),
    [],
  );
  const setCategoryDeleteTarget = useCallback(
    (category: LibraryCategory) =>
      categoryDialogsRef.current?.deleteCategory(category),
    [],
  );

  const search = useLibraryStore((s) => s.search);
  const setSearch = useLibraryStore((s) => s.setSearch);
  const selectedCategoryId = useLibraryStore((s) => s.selectedCategoryId);
  const setSelectedCategoryId = useLibraryStore((s) => s.setSelectedCategoryId);
  const defaultCategoryId = useLibraryStore((s) => s.defaultCategoryId);
  const setDefaultCategoryId = useLibraryStore((s) => s.setDefaultCategoryId);
  const sortOrder = useLibraryStore((s) => s.sortOrder);
  const displayMode = useLibraryStore((s) => s.displayMode);
  const novelsPerRow = useLibraryStore((s) => s.novelsPerRow);
  const showDownloadBadges = useLibraryStore((s) => s.showDownloadBadges);
  const showUnreadBadges = useLibraryStore((s) => s.showUnreadBadges);
  const showNumberBadges = useLibraryStore((s) => s.showNumberBadges);
  const downloadedOnlyMode = useLibraryStore((s) => s.downloadedOnlyMode);
  const unreadOnlyMode = useLibraryStore((s) => s.unreadOnlyMode);
  const localOnlyMode = useLibraryStore((s) => s.localOnlyMode);
  const completedOnlyMode = useLibraryStore((s) => s.completedOnlyMode);
  const repairNeededOnlyMode = useLibraryStore((s) => s.repairNeededOnlyMode);
  const clearFilters = useLibraryStore((s) => s.clearFilters);
  const wide = useMediaQuery("(min-width: 768px)", undefined, {
    getInitialValueInEffect: false,
  });
  const [debouncedSearch] = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const libraryFilter = useMemo<LibraryNovelRefreshFilter>(
    () => ({
      search: debouncedSearch,
      categoryId: selectedCategoryId,
      downloadedOnly: downloadedOnlyMode,
      sourceId: selectedSourceId,
      unreadOnly: unreadOnlyMode,
      localOnly: localOnlyMode,
      completedOnly: completedOnlyMode,
      repairNeededOnly: repairNeededOnlyMode,
    }),
    [
      debouncedSearch,
      downloadedOnlyMode,
      selectedCategoryId,
      selectedSourceId,
      unreadOnlyMode,
      localOnlyMode,
      completedOnlyMode,
      repairNeededOnlyMode,
    ],
  );
  const {
    novels,
    summary,
    tagSummary,
    sourceFilters,
    categories,
    categoryCounts,
    rows,
    libraryBodyRef,
  } = useLibraryQuery(active, libraryFilter, sortOrder);
  const {
    selectedIds,
    toggleSelected,
    clearSelection,
    selectAllMutation,
    assignCategoryMutation,
    batchDownloadMutation,
    batchDownloadAvailability,
    deleteSelectedDownloadsMutation,
    removeSelectedFromLibraryMutation,
  } = useLibrarySelection(libraryFilter, sortOrder, active);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  const [viewOptionsTab, setViewOptionsTab] =
    useState<LibraryViewOptionsTab>("filter");
  const openViewOptions = useCallback((tab?: LibraryViewOptionsTab) => {
    if (tab) setViewOptionsTab(tab);
    setViewOptionsOpen(true);
  }, []);

  useLibraryEntry(active);

  useEffect(() => {
    if (!active || !categories.isSuccess) return;
    const exists = (id: number | null) =>
      id === null ||
      id === UNCATEGORIZED_CATEGORY_ID ||
      categories.data.some((category) => category.id === id);
    if (!exists(defaultCategoryId)) setDefaultCategoryId(null);
    if (!exists(selectedCategoryId)) setSelectedCategoryId(null);
  }, [
    active,
    categories.data,
    categories.isSuccess,
    defaultCategoryId,
    selectedCategoryId,
    setDefaultCategoryId,
    setSelectedCategoryId,
  ]);

  useEffect(() => {
    if (
      selectedSourceId === null ||
      sourceFilters.isLoading ||
      !sourceFilters.data
    ) {
      return;
    }
    if (
      !sourceFilters.data.some((source) => source.pluginId === selectedSourceId)
    ) {
      setSelectedSourceId(null);
    }
  }, [selectedSourceId, sourceFilters.data, sourceFilters.isLoading]);

  const metadataRefreshMutation = useMutation({
    mutationFn: () =>
      refreshLibraryMetadata({
        aggregateTaskTitle: t("tasks.task.refreshLibraryMetadata"),
        filter: libraryFilter,
        taskTitle: (novel) =>
          t("tasks.task.refreshNovelMetadata", { name: novel.name }),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
      notifications.show({
        color: result.failures.length > 0 ? "warn" : "ok",
        message: t("library.refreshMetadataResult", {
          checked: result.checkedNovels,
          failed: result.failures.length,
          skipped: result.skippedNovels,
          total: result.targetNovels,
        }),
      });
    },
    onError: (error) => {
      showErrorToast(t("library.refreshMetadataFailed"), error);
    },
  });

  const handleActivate = useCallback(
    (id: number) => {
      if (selectedIds.size > 0) {
        toggleSelected(id);
        return;
      }
      void navigate({ to: "/novel", search: { id } });
    },
    [selectedIds, toggleSelected, navigate],
  );

  const handleLongPress = useCallback(
    (id: number) => {
      toggleSelected(id);
    },
    [toggleSelected],
  );

  const filterActive =
    debouncedSearch.trim() !== "" ||
    selectedCategoryId !== null ||
    selectedSourceId !== null ||
    downloadedOnlyMode ||
    unreadOnlyMode ||
    localOnlyMode ||
    completedOnlyMode ||
    repairNeededOnlyMode;

  const libraryError = novels.error;
  const isInitialLibraryLoading = novels.isLoading;
  const selectedNovelIds = Array.from(selectedIds);
  const selectedDownloadedChapterCount = selectedIds.size === summary.totalNovels
    ? summary.downloadedChapters
    : rows.reduce(
        (total, novel) => selectedIds.has(novel.id) ? total + novel.chaptersDownloaded : total,
        0,
      );
  const manualCategories = categories.data ?? [];
  const sourceRows = sourceFilters.data ?? [];
  const allCategoryCount = categoryCounts.data?.total ?? 0;
  const uncategorizedCategoryCount = categoryCounts.data?.uncategorized ?? 0;
  const assignableCategories = manualCategories.filter(
    (category) => category.id !== UNCATEGORIZED_CATEGORY_ID,
  );
  const overflowItems: OverflowMenuItem[] = [
    ...(wide
      ? []
      : [
          {
            disabled:
              summary.totalNovels === 0 || metadataRefreshMutation.isPending,
            icon: RefreshIcon,
            label: t("library.refresh"),
            onClick: () => metadataRefreshMutation.mutate(),
          },
        ]),
    {
      icon: ImportIcon,
      label: t("library.localImport.open"),
      onClick: openLocalImportInput,
    },
    {
      icon: FolderIcon,
      label: t("library.localNovel.create"),
      onClick: openLocalHome,
    },
    {
      icon: CategoryIcon,
      label: t("library.manageCategories"),
      onClick: () => setCategoriesOpen(true),
    },
    {
      icon: SettingsIcon,
      label: t("library.settings.title"),
      onClick: () => {
        void navigate({ to: "/settings", search: { section: "library" } });
      },
    },
  ];

  return (
    <>
      <PageFrame className="norea-library-page" size="full">
        <div className="norea-library-shell">
          <CategorySubpanel
            activeId={selectedCategoryId}
            allCount={allCategoryCount}
            categories={manualCategories}
            error={categories.error}
            loading={categories.isLoading}
            onCreate={openCreateCategory}
            onDelete={setCategoryDeleteTarget}
            onOpenDrawer={() => setCategoriesOpen(true)}
            onRename={openRenameCategory}
            onSelect={setSelectedCategoryId}
            t={t}
            uncategorizedCount={uncategorizedCategoryCount}
          />

          <section
            className="norea-library-main"
            aria-label={t("library.mainLabel")}
          >
            <LibraryAppBar
              onOpenViewOptions={() => openViewOptions()}
              onRefresh={() => metadataRefreshMutation.mutate()}
              onSearchChange={setSearch}
              overflowItems={overflowItems}
              refreshDisabled={summary.totalNovels === 0}
              refreshing={metadataRefreshMutation.isPending}
              search={search}
              wide={wide}
            />
            <LibraryQuickFilters
              counts={tagSummary}
              onClear={() => {
                clearFilters();
                setSelectedSourceId(null);
              }}
              onOpenFilters={() => openViewOptions("filter")}
              sourceActive={selectedSourceId !== null}
            />
            <StorageRecoveryStatus />

            {selectedIds.size > 0 ? (
              <div className="norea-library-selection-strip">
                <span>
                  {t("library.selectedCount", { count: selectedIds.size })}
                </span>
                <div className="norea-library-selection-actions">
                  <LibraryBatchDownloadPicker
                    available={batchDownloadAvailability.data === true}
                    onDownload={(mode) => batchDownloadMutation.mutate(mode)}
                    preparing={
                      batchDownloadMutation.isPending ||
                      batchDownloadAvailability.isPending
                    }
                    t={t}
                  />
                  <IconButton
                    className="norea-library-selection-icon norea-state-layer"
                    disabled={isInitialLibraryLoading || Boolean(libraryError) || summary.totalNovels === 0 || selectAllMutation.isPending}
                    label={t("library.selection.selectAll")}
                    onClick={() => selectAllMutation.mutate()}
                    size="sm"
                    title={t("library.selection.selectAll")}
                  >
                    {selectAllMutation.isPending ? <Loader size={14} /> : <CheckGlyph />}
                  </IconButton>
                  {selectedIds.size > 0 ? <>
                  <SelectionCategoryPicker
                    assigning={assignCategoryMutation.isPending}
                    categories={assignableCategories}
                    onAssign={(categoryId, mode) =>
                      assignCategoryMutation.mutate({
                        categoryId,
                        mode,
                        novelIds: selectedNovelIds,
                      })
                    }
                    t={t}
                  />
                  <IconButton
                    className="norea-library-selection-icon norea-state-layer"
                    disabled={
                      selectedDownloadedChapterCount === 0 ||
                      deleteSelectedDownloadsMutation.isPending ||
                      removeSelectedFromLibraryMutation.isPending
                    }
                    label={
                      selectedDownloadedChapterCount > 0
                        ? t("library.deleteSelectedDownloads")
                        : t("library.deleteSelectedDownloadsUnavailable")
                    }
                    onClick={() => {
                      deleteSelectedDownloadsMutation.mutate(selectedNovelIds);
                    }}
                    size="sm"
                    title={
                      selectedDownloadedChapterCount > 0
                        ? t("library.deleteSelectedDownloads")
                        : t("library.deleteSelectedDownloadsUnavailable")
                    }
                    tone="danger"
                  >
                    {deleteSelectedDownloadsMutation.isPending ? (
                      <Loader size={14} />
                    ) : (
                      <DownloadedGlyph />
                    )}
                  </IconButton>
                  <IconButton
                    className="norea-library-selection-icon norea-state-layer"
                    disabled={
                      removeSelectedFromLibraryMutation.isPending ||
                      deleteSelectedDownloadsMutation.isPending
                    }
                    label={t("library.removeSelectedFromLibrary")}
                    onClick={() => {
                      removeSelectedFromLibraryMutation.mutate(
                        selectedNovelIds,
                      );
                    }}
                    size="sm"
                    title={t("library.removeSelectedFromLibrary")}
                    tone="danger"
                  >
                    {removeSelectedFromLibraryMutation.isPending ? (
                      <Loader size={14} />
                    ) : (
                      <TrashGlyph />
                    )}
                  </IconButton>
                  <UnstyledButton onClick={clearSelection}>
                    {t("common.done")}
                  </UnstyledButton>
                  </> : null}
                </div>
              </div>
            ) : null}

            <div className="norea-library-body" ref={libraryBodyRef}>
              {isInitialLibraryLoading ? (
                <StateView
                  title={
                    <span className="norea-library-loading-title">
                      <Loader size="sm" />
                      <Text c="dimmed" component="span">
                        {t("library.loading")}
                      </Text>
                    </span>
                  }
                />
              ) : libraryError ? (
                <StateView
                  color="danger"
                  title={t("library.databaseError")}
                  message={
                    libraryError instanceof Error
                      ? libraryError.message
                      : String(libraryError)
                  }
                />
              ) : rows.length > 0 ? (
                <>
                  <LibraryGrid
                    novels={rows}
                    displayMode={displayMode}
                    novelsPerRow={novelsPerRow}
                    showDownloadBadges={showDownloadBadges}
                    showUnreadBadges={showUnreadBadges}
                    showNumberBadges={showNumberBadges}
                    selectedIds={selectedIds}
                    onActivate={handleActivate}
                    onLongPress={handleLongPress}
                  />
                  {novels.hasNextPage ? (
                    <div className="norea-library-load-more">
                      <TextButton
                        className="norea-library-load-more-action"
                        disabled={novels.isFetchingNextPage}
                        leftSection={
                          novels.isFetchingNextPage ? undefined : <PlusGlyph />
                        }
                        loading={novels.isFetchingNextPage}
                        onClick={() => {
                          void novels.fetchNextPage();
                        }}
                        size="sm"
                        tone="accent"
                      >
                        {t("common.loadMore")}
                      </TextButton>
                    </div>
                  ) : null}
                </>
              ) : filterActive ? (
                <StateView
                  color="warn"
                  title={t("common.noMatches")}
                  message={t("library.noMatches.message")}
                />
              ) : (
                <StateView
                  color="info"
                  title={t("library.empty.title")}
                  message={t("library.empty.message")}
                  action={{
                    icon: <ImportIcon size="1.125rem" />,
                    label: t("library.localImport.open"),
                    onClick: openLocalImportInput,
                  }}
                />
              )}
            </div>

          </section>
        </div>
      </PageFrame>

      <CategoriesDrawer
        allCount={allCategoryCount}
        categories={manualCategories}
        error={categories.error}
        loading={categories.isLoading}
        opened={active && categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        onCreate={openCreateCategory}
        onDelete={setCategoryDeleteTarget}
        onRename={openRenameCategory}
        selectedCategoryId={selectedCategoryId}
        onSelect={setSelectedCategoryId}
        uncategorizedCount={uncategorizedCategoryCount}
      />

      <LibraryViewOptions
        activeSourceId={selectedSourceId}
        counts={tagSummary}
        onClose={() => setViewOptionsOpen(false)}
        onSourceChange={setSelectedSourceId}
        onTabChange={setViewOptionsTab}
        opened={active && viewOptionsOpen}
        sources={sourceRows}
        sourcesLoading={sourceFilters.isLoading}
        tab={viewOptionsTab}
      />
      <LibraryLocalImport active={active} ref={localImportRef} />
      <LibraryCategoryDialogs active={active} ref={categoryDialogsRef} />
    </>
  );
}
