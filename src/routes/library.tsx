import { Loader, Popover, Text, UnstyledButton } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DownloadedGlyph,
  PlusGlyph,
  RefreshGlyph,
  TrashGlyph,
} from "../components/ActionGlyphs";
import { PageFrame, StateView } from "../components/AppFrame";
import { CategoriesDrawer } from "../components/CategoriesDrawer";
import { ConsoleStatusStrip } from "../components/ConsolePrimitives";
import { IconButton } from "../components/IconButton";
import { LibraryBatchDownloadPicker } from "../components/library/LibraryBatchDownloadPicker";
import {
  CategorySubpanel,
  getLibraryStats,
  getLibraryTags,
  SelectionCategoryPicker,
} from "../components/library/LibraryCategories";
import {
  LibraryCategoryDialogs,
  type LibraryCategoryDialogsHandle,
} from "../components/library/LibraryCategoryDialogs";
import {
  getLibrarySourceLabel,
  LibraryCommandSearch,
  LibraryScopeFilters,
  LibrarySortPicker,
  LibrarySourceFilterBar,
  MobileViewModePicker,
  SearchIcon,
  SlidersIcon,
  SORT_LABEL_KEYS,
  ViewModeToggle,
} from "../components/library/LibraryFilters";
import {
  LibraryLocalImport,
  type LibraryLocalImportHandle,
} from "../components/library/LibraryLocalImport";
import { ImportFileIcon } from "../components/library/LocalImportReviewRow";
import { useLibraryQuery } from "../components/library/use-library-query";
import { useLibrarySelection } from "../components/library/use-library-selection";
import { LibraryGrid } from "../components/LibraryGrid";
import { LibrarySettingsPanel } from "../components/LibrarySettingsPanel";
import { TextButton } from "../components/TextButton";
import {
  UNCATEGORIZED_CATEGORY_ID,
  type LibraryCategory,
} from "../db/queries/category";
import { type LibraryNovelRefreshFilter } from "../db/queries/novel";
import { useTranslation } from "../i18n";
import { refreshLibraryMetadata } from "../lib/updates/refresh-library-metadata";
import { useLibraryStore } from "../store/library";
import "../styles/library.css";

const SEARCH_DEBOUNCE_MS = 200;
interface LibraryPageProps {
  active?: boolean;
}

export function LibraryPage({ active = true }: LibraryPageProps) {
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const localImportRef = useRef<LibraryLocalImportHandle>(null);
  const categoryDialogsRef = useRef<LibraryCategoryDialogsHandle>(null);
  const openLocalImportInput = useCallback(
    () => localImportRef.current?.openFilePicker(),
    [],
  );
  const openLocalNovelEditor = useCallback(
    () => localImportRef.current?.openNovelEditor(),
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
  const sortOrder = useLibraryStore((s) => s.sortOrder);
  const setSortOrder = useLibraryStore((s) => s.setSortOrder);
  const displayMode = useLibraryStore((s) => s.displayMode);
  const setDisplayMode = useLibraryStore((s) => s.setDisplayMode);
  const novelsPerRow = useLibraryStore((s) => s.novelsPerRow);
  const showDownloadBadges = useLibraryStore((s) => s.showDownloadBadges);
  const showUnreadBadges = useLibraryStore((s) => s.showUnreadBadges);
  const showNumberBadges = useLibraryStore((s) => s.showNumberBadges);
  const downloadedOnlyMode = useLibraryStore((s) => s.downloadedOnlyMode);
  const setDownloadedOnlyMode = useLibraryStore((s) => s.setDownloadedOnlyMode);
  const unreadOnlyMode = useLibraryStore((s) => s.unreadOnlyMode);
  const setUnreadOnlyMode = useLibraryStore((s) => s.setUnreadOnlyMode);
  const [debouncedSearch] = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const libraryFilter = useMemo<LibraryNovelRefreshFilter>(
    () => ({
      search: debouncedSearch,
      categoryId: selectedCategoryId,
      downloadedOnly: downloadedOnlyMode,
      sourceId: selectedSourceId,
      unreadOnly: unreadOnlyMode,
    }),
    [
      debouncedSearch,
      downloadedOnlyMode,
      selectedCategoryId,
      selectedSourceId,
      unreadOnlyMode,
    ],
  );
  const {
    novels,
    summary,
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
    assignCategoryMutation,
    batchDownloadMutation,
    deleteSelectedDownloadsMutation,
    removeSelectedFromLibraryMutation,
  } = useLibrarySelection(libraryFilter, sortOrder);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
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
    unreadOnlyMode;

  const libraryError = novels.error;
  const isInitialLibraryLoading = novels.isLoading;
  const selectedNovelIds = Array.from(selectedIds);
  const selectedDownloadedChapterCount = rows.reduce(
    (total, novel) =>
      selectedIds.has(novel.id) ? total + novel.chaptersDownloaded : total,
    0,
  );
  const manualCategories = categories.data ?? [];
  const sourceRows = sourceFilters.data ?? [];
  const sourceTotalCount = sourceRows.reduce(
    (total, source) => total + source.totalNovels,
    0,
  );
  const allCategoryCount = categoryCounts.data?.total ?? 0;
  const uncategorizedCategoryCount = categoryCounts.data?.uncategorized ?? 0;
  const assignableCategories = manualCategories.filter(
    (category) => category.id !== UNCATEGORIZED_CATEGORY_ID,
  );
  const stats = getLibraryStats(summary, locale);
  const activeCategory =
    selectedCategoryId == null
      ? t("categories.all")
      : selectedCategoryId === UNCATEGORIZED_CATEGORY_ID
        ? t("categories.uncategorized")
        : (manualCategories.find(
            (category) => category.id === selectedCategoryId,
          )?.name ?? t("library.selectedCategory"));
  const status = t("library.status", {
    novels: summary.totalNovels,
    unread: stats.unreadChapters,
    downloaded: stats.downloadedChapters,
    total: stats.totalChapters,
  });
  const showMobileSearch = mobileSearchOpen || search.trim() !== "";
  const tags = getLibraryTags(summary, t);
  const sortLabel = t(SORT_LABEL_KEYS[sortOrder]);
  const activeSource =
    selectedSourceId == null
      ? null
      : sourceRows.find((source) => source.pluginId === selectedSourceId);
  const activeSourceLabel = activeSource
    ? getLibrarySourceLabel(activeSource, t)
    : t("library.sources.all");
  const metadataRefreshStatus = metadataRefreshMutation.isPending
    ? t("library.refreshMetadataRunning")
    : metadataRefreshMutation.error
      ? t("library.refreshMetadataFailed")
      : metadataRefreshMutation.data
        ? t("library.refreshMetadataResult", {
            checked: metadataRefreshMutation.data.checkedNovels,
            failed: metadataRefreshMutation.data.failures.length,
            skipped: metadataRefreshMutation.data.skippedNovels,
            total: metadataRefreshMutation.data.targetNovels,
          })
        : null;

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
            tags={tags}
            t={t}
            uncategorizedCount={uncategorizedCategoryCount}
          />

          <section
            className="norea-library-main"
            aria-label={t("library.mainLabel")}
          >
            <header className="norea-library-main-header">
              <div className="norea-library-header-copy">
                <h1 className="norea-library-title-heading">
                  <span className="norea-library-title-static">
                    {activeCategory}
                  </span>
                  <UnstyledButton
                    aria-label={t("library.openCategories", {
                      name: activeCategory,
                    })}
                    className="norea-library-title-button"
                    onClick={() => setCategoriesOpen(true)}
                    title={activeCategory}
                  >
                    <span>{activeCategory}</span>
                  </UnstyledButton>
                </h1>
                <span className="norea-library-header-meta">
                  {t("library.sortedMeta", {
                    count: summary.totalNovels,
                    sort: sortLabel.toLowerCase(),
                  })}
                </span>
              </div>
              <div className="norea-library-header-actions">
                <IconButton
                  active={showMobileSearch}
                  aria-controls="library-mobile-search"
                  aria-expanded={showMobileSearch}
                  className="norea-library-mobile-search-button"
                  label={t("library.search.aria")}
                  onClick={() => setMobileSearchOpen((open) => !open)}
                  size="sm"
                  title={t("library.search.placeholder")}
                >
                  <SearchIcon />
                </IconButton>
                <UnstyledButton
                  className="norea-library-mobile-category-button"
                  onClick={() => setCategoriesOpen(true)}
                >
                  {t("categories.title")}
                </UnstyledButton>
                <LibraryCommandSearch value={search} onChange={setSearch} />
                <LibraryScopeFilters
                  downloadedOnly={downloadedOnlyMode}
                  onDownloadedOnlyChange={setDownloadedOnlyMode}
                  onUnreadOnlyChange={setUnreadOnlyMode}
                  t={t}
                  unreadOnly={unreadOnlyMode}
                />
                <LibrarySortPicker
                  onChange={setSortOrder}
                  sortOrder={sortOrder}
                  t={t}
                />
                <ViewModeToggle
                  displayMode={displayMode}
                  onChange={setDisplayMode}
                  t={t}
                />
                <MobileViewModePicker
                  displayMode={displayMode}
                  onChange={setDisplayMode}
                  t={t}
                />
                <IconButton
                  className="norea-library-icon-button norea-library-local-import-button"
                  label={t("library.localImport.open")}
                  onClick={openLocalImportInput}
                  size="sm"
                  title={t("library.localImport.open")}
                >
                  <ImportFileIcon />
                </IconButton>
                <IconButton
                  className="norea-library-icon-button"
                  label={t("library.localNovel.create")}
                  onClick={openLocalNovelEditor}
                  size="sm"
                  title={t("library.localNovel.create")}
                >
                  <PlusGlyph />
                </IconButton>
                <IconButton
                  className="norea-library-icon-button norea-library-refresh-button"
                  disabled={
                    summary.totalNovels === 0 ||
                    metadataRefreshMutation.isPending
                  }
                  label={t("library.refreshMetadata")}
                  onClick={() => metadataRefreshMutation.mutate()}
                  size="sm"
                  title={t("library.refreshMetadata")}
                >
                  {metadataRefreshMutation.isPending ? (
                    <Loader size={14} />
                  ) : (
                    <RefreshGlyph />
                  )}
                </IconButton>
                <Popover position="bottom-end" shadow="md" width={390}>
                  <Popover.Target>
                    <IconButton
                      className="norea-library-icon-button"
                      label={t("library.settings.open")}
                      size="sm"
                      title={t("library.settings.title")}
                    >
                      <SlidersIcon />
                    </IconButton>
                  </Popover.Target>
                  <Popover.Dropdown className="norea-library-settings-popover">
                    <LibrarySettingsPanel />
                  </Popover.Dropdown>
                </Popover>
              </div>
            </header>
            {showMobileSearch ? (
              <div
                className="norea-library-mobile-search-row"
                id="library-mobile-search"
              >
                <LibraryCommandSearch value={search} onChange={setSearch} />
              </div>
            ) : null}

            {sourceFilters.isLoading ||
            sourceRows.length > 0 ||
            selectedSourceId !== null ? (
              <LibrarySourceFilterBar
                activeSourceId={selectedSourceId}
                loading={sourceFilters.isLoading}
                onChange={setSelectedSourceId}
                sources={sourceRows}
                t={t}
                totalCount={sourceTotalCount}
              />
            ) : null}

            {selectedIds.size > 0 ? (
              <div className="norea-library-selection-strip">
                <span>
                  {t("library.selectedCount", { count: selectedIds.size })}
                </span>
                <div className="norea-library-selection-actions">
                  <LibraryBatchDownloadPicker
                    onDownload={(mode) => batchDownloadMutation.mutate(mode)}
                    preparing={batchDownloadMutation.isPending}
                    t={t}
                  />
                  <SelectionCategoryPicker
                    assigning={assignCategoryMutation.isPending}
                    categories={assignableCategories}
                    onAssign={(categoryId) =>
                      assignCategoryMutation.mutate({
                        categoryId,
                        novelIds: selectedNovelIds,
                      })
                    }
                    t={t}
                  />
                  <IconButton
                    className="norea-library-selection-icon"
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
                      if (
                        !window.confirm(
                          t("library.deleteSelectedDownloadsConfirm", {
                            chapters: selectedDownloadedChapterCount,
                            count: selectedIds.size,
                          }),
                        )
                      ) {
                        return;
                      }
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
                    className="norea-library-selection-icon"
                    disabled={
                      removeSelectedFromLibraryMutation.isPending ||
                      deleteSelectedDownloadsMutation.isPending
                    }
                    label={t("library.removeSelectedFromLibrary")}
                    onClick={() => {
                      if (
                        !window.confirm(
                          t("library.removeSelectedFromLibraryConfirm", {
                            count: selectedIds.size,
                          }),
                        )
                      ) {
                        return;
                      }
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
                  color="red"
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
                  color="yellow"
                  title={t("common.noMatches")}
                  message={t("library.noMatches.message")}
                />
              ) : (
                <StateView
                  color="blue"
                  title={t("library.empty.title")}
                  message={t("library.empty.message")}
                  action={{
                    icon: <ImportFileIcon />,
                    label: t("library.localImport.open"),
                    onClick: openLocalImportInput,
                  }}
                />
              )}
            </div>

            <ConsoleStatusStrip className="norea-library-status-strip">
              <span>{status}</span>
              <span>
                {t("library.statusUpdated", { time: stats.lastUpdatedLabel })}
              </span>
              <span>{activeCategory}</span>
              <span>{activeSourceLabel}</span>
              <span>{t("library.statusSort", { sort: sortLabel })}</span>
              {metadataRefreshStatus ? (
                <span>{metadataRefreshStatus}</span>
              ) : null}
            </ConsoleStatusStrip>
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

      <LibraryLocalImport active={active} ref={localImportRef} />
      <LibraryCategoryDialogs active={active} ref={categoryDialogsRef} />
    </>
  );
}
