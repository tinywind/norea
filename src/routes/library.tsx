import { Button } from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageFrame, StateView } from "../components/AppFrame";
import {
  CategoryList,
  CategoryManager,
  CategoryTabs,
  getLibraryCategoryEntries,
} from "../components/library/LibraryCategories";
import {
  LibraryCategorySheet,
  LibraryDownloadGoalSheet,
} from "../components/library/LibrarySelectionSheets";
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
import {
  ContinueReadingShelf,
  isContinueReadingShelfVisible,
} from "../components/library/ContinueReadingShelf";
import { LibrarySearchSources } from "../components/library/LibrarySearchSources";
import { useLibraryQuery } from "../components/library/use-library-query";
import { useLibraryEntry } from "../components/library/use-library-entry";
import { StorageRecoveryBanner } from "../components/runtime/StorageRecovery";
import { useLibrarySelection } from "../components/library/use-library-selection";
import { LibraryGrid, LibraryGridSkeleton } from "../components/LibraryGrid";
import { useDownloadGoalOfflineStates } from "../components/library/use-download-goal-offline-states";
import {
  UNCATEGORIZED_CATEGORY_ID,
  type LibraryCategory,
} from "../db/queries/category";
import { type LibraryNovelRefreshFilter } from "../db/queries/novel";
import {
  CategoryIcon,
  DeleteDownloadIcon,
  DownloadIcon,
  FolderIcon,
  ImportIcon,
  OverflowIcon,
  RefreshIcon,
  SelectIcon,
  SettingsIcon,
  TrashIcon,
} from "../components/ui/icons";
import {
  OverflowMenu,
  type OverflowMenuItem,
} from "../components/ui/OverflowMenu";
import { SelectionAction, SelectionBar } from "../components/ui/SelectionBar";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { showErrorToast } from "../lib/runtime/error-toast";
import { checkForNewChapters } from "../lib/updates/check-library-updates";
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
  const showContinueReading = useLibraryStore((s) => s.showContinueReading);
  const downloadedOnlyMode = useLibraryStore((s) => s.downloadedOnlyMode);
  const unreadOnlyMode = useLibraryStore((s) => s.unreadOnlyMode);
  const localOnlyMode = useLibraryStore((s) => s.localOnlyMode);
  const completedOnlyMode = useLibraryStore((s) => s.completedOnlyMode);
  const repairNeededOnlyMode = useLibraryStore((s) => s.repairNeededOnlyMode);
  const clearFilters = useLibraryStore((s) => s.clearFilters);
  const wide = useMediaQuery("(min-width: 768px)", undefined, {
    getInitialValueInEffect: false,
  });
  const desktop = useMediaQuery("(min-width: 992px)", undefined, {
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
    selectionMode,
    toggleSelected,
    clearSelection,
    enterSelection,
    exitSelection,
    selectAllMutation,
    assignCategoryMutation,
    setDownloadGoalMutation,
    deleteSelectedDownloadsMutation,
    removeSelectedFromLibraryMutation,
  } = useLibrarySelection(libraryFilter, sortOrder, active);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [downloadSheetOpen, setDownloadSheetOpen] = useState(false);
  const offlineStates = useDownloadGoalOfflineStates(active && showDownloadBadges);
  const [categorySheetOpen, setCategorySheetOpen] = useState(false);
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
      checkForNewChapters({
        aggregateTaskTitle: t("tasks.task.checkLibraryUpdates"),
        filter: libraryFilter,
        limit: 1,
        taskTitle: (novel) => t("tasks.task.checkUpdates", { name: novel.name }),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
      notifications.show({
        color: result.failures.length > 0 ? "warn" : "ok",
        message: t(result.failures.length > 0 ? "library.checkResult.failed" : "library.checkResult", {
          checked: result.checkedNovels,
          failed: result.failures.length,
          found: result.newChapters,
        }),
      });
    },
    onError: (error) => {
      showErrorToast(t("library.checkFailed"), error);
    },
  });

  const handleActivate = useCallback(
    (id: number) => {
      if (selectionMode) {
        toggleSelected(id);
        return;
      }
      void navigate({ to: "/novel", search: { id } });
    },
    [selectionMode, toggleSelected, navigate],
  );

  const handleLongPress = useCallback(
    (id: number) => {
      toggleSelected(id);
    },
    [toggleSelected],
  );

  const trimmedSearch = debouncedSearch.trim();
  const filterActive =
    trimmedSearch !== "" ||
    selectedSourceId !== null ||
    downloadedOnlyMode ||
    unreadOnlyMode ||
    localOnlyMode ||
    completedOnlyMode ||
    repairNeededOnlyMode;

  const showContinueShelf = isContinueReadingShelfVisible({
    enabled: showContinueReading,
    filterActive,
    search,
    selectedCategoryId,
    selectionMode,
  });
  const openChapter = useCallback(
    (chapterId: number) => {
      void navigate({ to: "/reader", search: { chapterId } });
    },
    [navigate],
  );

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
  const categoryEntries = getLibraryCategoryEntries(
    manualCategories,
    {
      all: categoryCounts.data?.total ?? 0,
      uncategorized: categoryCounts.data?.uncategorized ?? 0,
    },
    t,
  );
  const categoryListProps = {
    activeId: selectedCategoryId,
    entries: categoryEntries,
    error: categories.error,
    loading: categories.isLoading,
    onCreate: openCreateCategory,
    onDelete: setCategoryDeleteTarget,
    onRename: openRenameCategory,
    onSelect: setSelectedCategoryId,
  };
  const assignableCategories = manualCategories.filter(
    (category) => category.id !== UNCATEGORIZED_CATEGORY_ID,
  );
  const clearAllFilters = () => {
    clearFilters();
    setSelectedSourceId(null);
    setSearch("");
  };
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
      disabled: summary.totalNovels === 0,
      icon: SelectIcon,
      label: t("library.selection.start"),
      onClick: enterSelection,
    },
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
      onClick: () => setCategoryManagerOpen(true),
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
          {active && selectionMode ? (
            <SelectionBar
              actions={
                <>
                  <SelectionAction
                    disabled={selectedIds.size === 0 || setDownloadGoalMutation.isPending}
                    icon={DownloadIcon}
                    label={t("library.selection.download")}
                    onClick={() => setDownloadSheetOpen(true)}
                  />
                  <SelectionAction
                    disabled={selectedIds.size === 0}
                    icon={CategoryIcon}
                    label={t("library.selection.categories")}
                    onClick={() => setCategorySheetOpen(true)}
                  />
                  <OverflowMenu
                    items={[
                      {
                        disabled:
                          selectedDownloadedChapterCount === 0 ||
                          deleteSelectedDownloadsMutation.isPending,
                        icon: DeleteDownloadIcon,
                        label: t("library.deleteSelectedDownloads"),
                        onClick: () =>
                          deleteSelectedDownloadsMutation.mutate({
                            downloadedChapters: selectedDownloadedChapterCount,
                            novelIds: selectedNovelIds,
                          }),
                      },
                      {
                        danger: true,
                        disabled: removeSelectedFromLibraryMutation.isPending,
                        icon: TrashIcon,
                        label: t("library.removeSelectedFromLibrary"),
                        onClick: () =>
                          removeSelectedFromLibraryMutation.mutate(selectedNovelIds),
                      },
                    ]}
                    label={t("common.more")}
                    trigger={
                      <SelectionAction
                        disabled={selectedIds.size === 0}
                        icon={OverflowIcon}
                        label={t("common.more")}
                      />
                    }
                  />
                </>
              }
              clearDisabled={selectedIds.size === 0}
              label={t("library.selectedCount", { count: selectedIds.size })}
              onClear={clearSelection}
              onExit={exitSelection}
              onSelectAll={() => selectAllMutation.mutate()}
              selectAllDisabled={
                isInitialLibraryLoading ||
                Boolean(libraryError) ||
                summary.totalNovels === 0 ||
                selectAllMutation.isPending
              }
              selectAllPending={selectAllMutation.isPending}
            />
          ) : (
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
          )}
          <div className="norea-library-columns">
          {desktop ? (
            <aside
              aria-label={t("categories.title")}
              className="norea-library-categories"
            >
              <CategoryList {...categoryListProps} />
            </aside>
          ) : null}
          <section
            className="norea-library-main"
            aria-label={t("library.mainLabel")}
          >
            {desktop ? null : (
              <CategoryTabs
                activeId={selectedCategoryId}
                entries={categoryEntries}
                onSelect={setSelectedCategoryId}
              />
            )}
            <LibraryQuickFilters
              counts={tagSummary}
              onClear={() => {
                clearFilters();
                setSelectedSourceId(null);
              }}
              onOpenFilters={() => openViewOptions("filter")}
              sourceActive={selectedSourceId !== null}
            />
            <StorageRecoveryBanner />

            <div className="norea-library-body" ref={libraryBodyRef}>
              {showContinueShelf && !isInitialLibraryLoading && !libraryError ? (
                <ContinueReadingShelf active={active} onOpen={openChapter} />
              ) : null}
              {isInitialLibraryLoading ? (
                <LibraryGridSkeleton
                  displayMode={displayMode}
                  label={t("library.loading")}
                  novelsPerRow={novelsPerRow}
                />
              ) : libraryError ? (
                <div className="norea-library-state">
                  <StateView
                    action={{
                      label: t("common.retry"),
                      onClick: () => {
                        void novels.refetch();
                      },
                    }}
                    color="danger"
                    details={{
                      content: describeError(libraryError),
                      label: t("common.details"),
                    }}
                    message={t("library.loadError.message")}
                    title={t("library.loadError.title")}
                  />
                </div>
              ) : rows.length > 0 ? (
                <>
                  <LibraryGrid
                    novels={rows}
                    displayMode={displayMode}
                    novelsPerRow={novelsPerRow}
                    showDownloadBadges={showDownloadBadges}
                    showUnreadBadges={showUnreadBadges}
                    showNumberBadges={showNumberBadges}
                    offlineStates={offlineStates}
                    selectedIds={selectedIds}
                    selectionMode={selectionMode}
                    onActivate={handleActivate}
                    onLongPress={handleLongPress}
                  />
                  {novels.hasNextPage ? (
                    <div className="norea-library-load-more">
                      <Button
                        loading={novels.isFetchingNextPage}
                        onClick={() => {
                          void novels.fetchNextPage();
                        }}
                        variant="light"
                      >
                        {t("common.loadMore")}
                      </Button>
                    </div>
                  ) : null}
                  {trimmedSearch !== "" ? (
                    <LibrarySearchSources
                      empty={false}
                      onClearFilters={clearAllFilters}
                      query={trimmedSearch}
                    />
                  ) : null}
                </>
              ) : trimmedSearch !== "" ? (
                <LibrarySearchSources
                  empty
                  onClearFilters={clearAllFilters}
                  query={trimmedSearch}
                />
              ) : filterActive ? (
                <div className="norea-library-state">
                  <StateView
                    action={{
                      label: t("library.noMatches.clear"),
                      onClick: clearAllFilters,
                    }}
                    message={t("library.noMatches.message")}
                    title={t("common.noMatches")}
                  />
                </div>
              ) : selectedCategoryId !== null ? (
                <div className="norea-library-state">
                  <StateView title={t("library.emptyCategory")} />
                </div>
              ) : (
                <div className="norea-library-state">
                  <StateView
                    action={{
                      label: t("library.localImport.open"),
                      onClick: openLocalImportInput,
                    }}
                    message={t("library.empty.message")}
                    secondaryAction={{
                      label: t("library.empty.browse"),
                      onClick: () => {
                        void navigate({ to: "/browse", search: { q: "", tab: "sources" } });
                      },
                    }}
                    title={t("library.empty.title")}
                  />
                </div>
              )}
            </div>

          </section>
          </div>
        </div>
      </PageFrame>

      <CategoryManager
        {...categoryListProps}
        fullScreen={!wide}
        onClose={() => setCategoryManagerOpen(false)}
        opened={active && categoryManagerOpen}
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
      <LibraryDownloadGoalSheet
        applying={setDownloadGoalMutation.isPending}
        novelIds={selectedNovelIds}
        onApply={(goal) =>
          setDownloadGoalMutation.mutate(
            { goal, novelIds: selectedNovelIds },
            { onSuccess: () => setDownloadSheetOpen(false) },
          )
        }
        onClose={() => setDownloadSheetOpen(false)}
        opened={active && selectionMode && downloadSheetOpen}
      />
      <LibraryCategorySheet
        applying={assignCategoryMutation.isPending}
        categories={assignableCategories}
        novelIds={selectedNovelIds}
        onApply={(change) =>
          assignCategoryMutation.mutate(
            { ...change, novelIds: selectedNovelIds },
            { onSuccess: () => setCategorySheetOpen(false) },
          )
        }
        onClose={() => setCategorySheetOpen(false)}
        onCreateCategory={openCreateCategory}
        opened={active && selectionMode && categorySheetOpen}
      />
      <LibraryLocalImport active={active} ref={localImportRef} />
      <LibraryCategoryDialogs active={active} ref={categoryDialogsRef} />
    </>
  );
}
