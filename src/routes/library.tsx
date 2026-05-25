import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Group,
  Loader,
  Modal,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { PageFrame, StateView } from "../components/AppFrame";
import {
  PlusGlyph,
  DownloadGlyph,
  DownloadedGlyph,
  RefreshGlyph,
  SortGlyph,
} from "../components/ActionGlyphs";
import { CategoriesDrawer } from "../components/CategoriesDrawer";
import { ConsoleStatusStrip } from "../components/ConsolePrimitives";
import { IconButton } from "../components/IconButton";
import { LibraryGrid } from "../components/LibraryGrid";
import { LibrarySettingsPanel } from "../components/LibrarySettingsPanel";
import { LocalCoverPicker } from "../components/LocalCoverPicker";
import { TextButton } from "../components/TextButton";
import {
  addNovelsToCategory,
  deleteCategory,
  getLibraryCategoryCounts,
  insertCategory,
  listCategories,
  UNCATEGORIZED_CATEGORY_ID,
  updateCategory,
  type LibraryCategory,
} from "../db/queries/category";
import {
  listChaptersByNovel,
  type ChapterListRow,
} from "../db/queries/chapter";
import {
  getLibraryNovelSummary,
  getNovelById,
  listLibraryNovelPage,
  findLocalNovelByPath,
  setNovelInLibrary,
  upsertLocalNovel,
  upsertLocalNovelMetadata,
  type LibraryNovelCursor,
  type LibraryNovelSummary,
  type LibraryNovel,
  type LocalNovelMetadataInput,
  type LocalNovelImportResult,
} from "../db/queries/novel";
import {
  deleteDownloadCacheNovel,
  listDownloadCacheChapters,
} from "../db/queries/download-cache";
import { clearChapterMedia } from "../lib/chapter-media";
import {
  analyzeLocalImportFile,
  clearLocalImportFileCache,
  convertLocalImportFile,
  LocalImportError,
  type LocalImportAnalysis,
  type LocalImportFormat,
} from "../lib/local-import";
import { cacheLocalImportedChapterMedia } from "../lib/local-import-media";
import { syncLocalChapterStorageAfterOrderChange } from "../lib/local-chapter-storage";
import { mirrorStoredNovelChapters } from "../lib/chapter-content-storage";
import { MAX_ROUTE_QUERY_ROWS } from "../lib/performance-budgets";
import {
  enqueueChapterDownloadBatch,
  getChapterDownloadStatus,
  type ChapterDownloadStatus,
} from "../lib/tasks/chapter-download";
import { refreshLibraryMetadata } from "../lib/updates/refresh-library-metadata";
import {
  useLibraryStore,
  type LibraryDisplayMode,
  type LibrarySortOrder,
} from "../store/library";
import { LIBRARY_SORT_ORDERS } from "../lib/library-settings-options";
import { useReaderStore } from "../store/reader";
import {
  formatRelativeTimeForLocale,
  useTranslation,
  type TranslationKey,
} from "../i18n";
import "../styles/library.css";

const SEARCH_DEBOUNCE_MS = 200;
const LIBRARY_PAGE_SIZE = Math.min(100, MAX_ROUTE_QUERY_ROWS);
const LIBRARY_LOAD_MORE_THRESHOLD_PX = 640;
const LOCAL_IMPORT_ACCEPT = ".txt,.html,.htm,.md,.markdown,.epub,.pdf";
const EMPTY_LOCAL_NOVEL_FORM: LocalNovelMetadataInput = {
  name: "",
  cover: "",
  summary: "",
  author: "",
  artist: "",
  status: "",
  genres: "",
};
const EMPTY_LIBRARY_SUMMARY: LibraryNovelSummary = {
  completeNovels: 0,
  downloadedChapters: 0,
  downloadedNovels: 0,
  lastUpdatedAt: null,
  localNovels: 0,
  totalChapters: 0,
  totalNovels: 0,
  unreadChapters: 0,
  unreadNovels: 0,
};

interface LibraryPageProps {
  active?: boolean;
}

const SORT_LABEL_KEYS: Record<LibrarySortOrder, TranslationKey> = {
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

type CategoryEditorState =
  | { mode: "create" }
  | { category: LibraryCategory; mode: "rename" };

interface AssignCategoryInput {
  categoryId: number;
  novelIds: number[];
}

type TranslateFn = ReturnType<typeof useTranslation>["t"];

type LibraryBatchDownloadMode = "all" | "unread" | "next10" | "next30";

type LocalImportReviewStatus =
  | "ready"
  | "duplicate"
  | "unsupported"
  | "error"
  | "importing"
  | "imported";

interface LocalImportReviewItem {
  analysis?: LocalImportAnalysis;
  duplicateKind?: "library" | "selection";
  error?: string;
  existingNovelId?: number;
  file: File;
  format?: LocalImportFormat;
  id: string;
  importedChapterCount?: number;
  importedNovelId?: number;
  status: LocalImportReviewStatus;
}

interface LocalImportItemResult {
  error?: string;
  itemId: string;
  result?: LocalNovelImportResult;
  status: "error" | "imported";
}

interface LibraryBatchDownloadOptionConfig {
  descriptionKey: TranslationKey;
  labelKey: TranslationKey;
  mode: LibraryBatchDownloadMode;
}

interface LibraryBatchDownloadPickerProps {
  onDownload: (mode: LibraryBatchDownloadMode) => void;
  preparing: boolean;
  t: TranslateFn;
}

const LIBRARY_BATCH_DOWNLOAD_OPTIONS: LibraryBatchDownloadOptionConfig[] = [
  {
    descriptionKey: "library.batchDownload.allDescription",
    labelKey: "novel.batchDownload.all",
    mode: "all",
  },
  {
    descriptionKey: "library.batchDownload.unreadDescription",
    labelKey: "novel.batchDownload.unread",
    mode: "unread",
  },
  {
    descriptionKey: "library.batchDownload.next10Description",
    labelKey: "novel.batchDownload.next10",
    mode: "next10",
  },
  {
    descriptionKey: "library.batchDownload.next30Description",
    labelKey: "novel.batchDownload.next30",
    mode: "next30",
  },
];

function isActiveChapterDownloadStatus(
  status: ChapterDownloadStatus | undefined,
): boolean {
  return (
    status?.kind === "queued" ||
    status?.kind === "running" ||
    status?.kind === "done"
  );
}

function canQueueChapterDownload(chapter: ChapterListRow): boolean {
  return (
    !chapter.isDownloaded &&
    !isActiveChapterDownloadStatus(getChapterDownloadStatus(chapter.id))
  );
}

function getLibraryBatchDownloadTargets(
  mode: LibraryBatchDownloadMode,
  chapters: readonly ChapterListRow[],
  lastReadChapterId: number | undefined,
): ChapterListRow[] {
  const readingOrder = [...chapters].sort(
    (left, right) => left.position - right.position,
  );
  const candidates = readingOrder.filter(canQueueChapterDownload);

  switch (mode) {
    case "all":
      return candidates;
    case "unread":
      return candidates.filter((chapter) => chapter.unread);
    case "next10":
    case "next30": {
      const currentIndex =
        lastReadChapterId === undefined
          ? -1
          : readingOrder.findIndex(
              (chapter) => chapter.id === lastReadChapterId,
            );
      if (currentIndex < 0) return [];

      const limit = mode === "next10" ? 10 : 30;
      return readingOrder
        .slice(currentIndex + 1)
        .filter(canQueueChapterDownload)
        .slice(0, limit);
    }
  }
}

export function LibraryPage({ active = true }: LibraryPageProps) {
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const search = useLibraryStore((s) => s.search);
  const setSearch = useLibraryStore((s) => s.setSearch);
  const selectedCategoryId = useLibraryStore((s) => s.selectedCategoryId);
  const setSelectedCategoryId = useLibraryStore(
    (s) => s.setSelectedCategoryId,
  );
  const sortOrder = useLibraryStore((s) => s.sortOrder);
  const setSortOrder = useLibraryStore((s) => s.setSortOrder);
  const displayMode = useLibraryStore((s) => s.displayMode);
  const setDisplayMode = useLibraryStore((s) => s.setDisplayMode);
  const novelsPerRow = useLibraryStore((s) => s.novelsPerRow);
  const showDownloadBadges = useLibraryStore((s) => s.showDownloadBadges);
  const showUnreadBadges = useLibraryStore((s) => s.showUnreadBadges);
  const showNumberBadges = useLibraryStore((s) => s.showNumberBadges);
  const downloadedOnlyMode = useLibraryStore((s) => s.downloadedOnlyMode);
  const setDownloadedOnlyMode = useLibraryStore(
    (s) => s.setDownloadedOnlyMode,
  );
  const unreadOnlyMode = useLibraryStore((s) => s.unreadOnlyMode);
  const setUnreadOnlyMode = useLibraryStore((s) => s.setUnreadOnlyMode);
  const [debouncedSearch] = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  const novels = useInfiniteQuery({
    queryKey: [
      "novel",
      "library",
      {
        search: debouncedSearch,
        categoryId: selectedCategoryId,
        downloadedOnly: downloadedOnlyMode,
        limit: LIBRARY_PAGE_SIZE,
        unreadOnly: unreadOnlyMode,
        sortOrder,
      },
    ] as const,
    initialPageParam: null as LibraryNovelCursor | null,
    queryFn: ({ pageParam }) =>
      listLibraryNovelPage({
        search: debouncedSearch,
        categoryId: selectedCategoryId,
        cursor: pageParam,
        downloadedOnly: downloadedOnlyMode,
        limit: LIBRARY_PAGE_SIZE,
        unreadOnly: unreadOnlyMode,
        sortOrder,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const librarySummary = useQuery({
    queryKey: [
      "novel",
      "library",
      "summary",
      {
        search: debouncedSearch,
        categoryId: selectedCategoryId,
        downloadedOnly: downloadedOnlyMode,
        unreadOnly: unreadOnlyMode,
      },
    ] as const,
    queryFn: () =>
      getLibraryNovelSummary({
        search: debouncedSearch,
        categoryId: selectedCategoryId,
        downloadedOnly: downloadedOnlyMode,
        unreadOnly: unreadOnlyMode,
      }),
  });

  const categories = useQuery({
    queryKey: ["category", "list"],
    queryFn: listCategories,
  });

  const categoryCounts = useQuery({
    queryKey: ["category", "counts"],
    queryFn: getLibraryCategoryCounts,
  });

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const libraryBodyRef = useRef<HTMLDivElement>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [categoryEditor, setCategoryEditor] =
    useState<CategoryEditorState | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryDeleteTarget, setCategoryDeleteTarget] =
    useState<LibraryCategory | null>(null);
  const localImportInputRef = useRef<HTMLInputElement>(null);
  const [localImportOpen, setLocalImportOpen] = useState(false);
  const [localImportItems, setLocalImportItems] = useState<
    LocalImportReviewItem[]
  >([]);
  const [localImportAnalyzing, setLocalImportAnalyzing] = useState(false);
  const [localNovelEditorOpen, setLocalNovelEditorOpen] = useState(false);
  const [localNovelForm, setLocalNovelForm] = useState<LocalNovelMetadataInput>(
    EMPTY_LOCAL_NOVEL_FORM,
  );

  useEffect(() => {
    setSelectedIds(new Set());
  }, [
    debouncedSearch,
    downloadedOnlyMode,
    selectedCategoryId,
    sortOrder,
    unreadOnlyMode,
  ]);

  const invalidateLibraryCategories = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["category"] });
    void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
  }, [queryClient]);

  const createCategoryMutation = useMutation({
    mutationFn: (name: string) => insertCategory({ name }),
    onSuccess: () => {
      invalidateLibraryCategories();
      setCategoryEditor(null);
      setCategoryName("");
    },
  });

  const renameCategoryMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      updateCategory(id, { name }),
    onSuccess: () => {
      invalidateLibraryCategories();
      setCategoryEditor(null);
      setCategoryName("");
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: (id: number) => deleteCategory(id),
    onSuccess: (_data, id) => {
      invalidateLibraryCategories();
      if (selectedCategoryId === id) {
        setSelectedCategoryId(null);
      }
      setCategoryDeleteTarget(null);
    },
  });

  const assignCategoryMutation = useMutation({
    mutationFn: ({ categoryId, novelIds }: AssignCategoryInput) =>
      addNovelsToCategory(novelIds, categoryId),
    onSuccess: () => {
      invalidateLibraryCategories();
      setSelectedIds(new Set());
    },
  });

  const batchDownloadMutation = useMutation({
    mutationFn: async (mode: LibraryBatchDownloadMode) => {
      const batchSources: Array<{
        chapters: ChapterListRow[];
        novel: Pick<LibraryNovel, "id" | "name" | "path" | "pluginId">;
      }> = [];
      let total = 0;
      const lastReadChapterByNovel =
        useReaderStore.getState().lastReadChapterByNovel;

      for (const novelId of selectedIds) {
        const novel = await getNovelById(novelId);
        if (!novel || novel.isLocal) continue;

        const chapters = await listChaptersByNovel(novel.id);
        const targetChapters = getLibraryBatchDownloadTargets(
          mode,
          chapters,
          lastReadChapterByNovel[novel.id],
        );

        if (targetChapters.length > 0) {
          batchSources.push({
            chapters: targetChapters,
            novel,
          });
          total += targetChapters.length;
        }
      }

      if (total === 0) return 0;

      const chapterDownloadJobs = batchSources.flatMap(({ chapters, novel }) =>
        chapters.map((chapter) => ({
          id: chapter.id,
          pluginId: novel.pluginId,
          chapterPath: chapter.path,
          chapterName: chapter.name,
          chapterNumber: chapter.chapterNumber ?? undefined,
          contentType: chapter.contentType,
          novelId: novel.id,
          novelName: novel.name,
          novelPath: novel.path,
          title: t("tasks.task.downloadChapter", { name: chapter.name }),
        })),
      );

      const handle = enqueueChapterDownloadBatch({
        jobs: chapterDownloadJobs,
        title: t("tasks.task.downloadChapterBatch", { count: total }),
        total,
      });
      try {
        const result = await handle.promise;
        return result.total;
      } finally {
        void queryClient.invalidateQueries({ queryKey: ["novel"] });
      }
    },
  });

  const deleteSelectedDownloadsMutation = useMutation({
    mutationFn: async (novelIds: readonly number[]) => {
      let deletedChapters = 0;

      for (const novelId of novelIds) {
        const chapters = await listDownloadCacheChapters(novelId);
        const result = await deleteDownloadCacheNovel(novelId);
        deletedChapters += result.rowsAffected;
        await Promise.all(
          chapters.map((chapter) => clearChapterMedia(chapter.id)),
        );
      }

      return deletedChapters;
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      invalidateLibraryCategories();
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
    },
  });

  const removeSelectedFromLibraryMutation = useMutation({
    mutationFn: async (novelIds: readonly number[]) => {
      for (const novelId of novelIds) {
        await setNovelInLibrary(novelId, false);
      }
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      invalidateLibraryCategories();
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
    },
  });

  const metadataRefreshMutation = useMutation({
    mutationFn: () =>
      refreshLibraryMetadata({
        aggregateTaskTitle: t("tasks.task.refreshLibraryMetadata"),
        categoryId: selectedCategoryId,
        taskTitle: (novel) =>
          t("tasks.task.refreshNovelMetadata", { name: novel.name }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
    },
  });

  const toggleSelected = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const openCreateCategory = useCallback(() => {
    createCategoryMutation.reset();
    renameCategoryMutation.reset();
    setCategoryName("");
    setCategoryEditor({ mode: "create" });
  }, [createCategoryMutation, renameCategoryMutation]);

  const openRenameCategory = useCallback(
    (category: LibraryCategory) => {
      createCategoryMutation.reset();
      renameCategoryMutation.reset();
      setCategoryName(category.name);
      setCategoryEditor({ category, mode: "rename" });
    },
    [createCategoryMutation, renameCategoryMutation],
  );

  const closeCategoryEditor = useCallback(() => {
    createCategoryMutation.reset();
    renameCategoryMutation.reset();
    setCategoryEditor(null);
    setCategoryName("");
  }, [createCategoryMutation, renameCategoryMutation]);

  const handleCategorySubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!categoryEditor || categoryName.trim() === "") return;

      if (categoryEditor.mode === "create") {
        createCategoryMutation.mutate(categoryName);
      } else {
        renameCategoryMutation.mutate({
          id: categoryEditor.category.id,
          name: categoryName,
        });
      }
    },
    [
      categoryEditor,
      categoryName,
      createCategoryMutation,
      renameCategoryMutation,
    ],
  );

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
    downloadedOnlyMode ||
    unreadOnlyMode;

  const rows = useMemo(
    () => novels.data?.pages.flatMap((page) => page.novels) ?? [],
    [novels.data?.pages],
  );
  const summary = librarySummary.data ?? EMPTY_LIBRARY_SUMMARY;
  const libraryError = novels.error ?? librarySummary.error;
  const isInitialLibraryLoading = novels.isLoading || librarySummary.isLoading;
  const loadMoreIfNeeded = useCallback(() => {
    if (
      !active ||
      !novels.hasNextPage ||
      novels.isFetchingNextPage ||
      novels.isLoading
    ) {
      return;
    }

    const scrollElement = libraryBodyRef.current;
    if (!scrollElement) return;

    const distanceToBottom =
      scrollElement.scrollHeight -
      scrollElement.clientHeight -
      scrollElement.scrollTop;
    if (distanceToBottom <= LIBRARY_LOAD_MORE_THRESHOLD_PX) {
      void novels.fetchNextPage();
    }
  }, [
    active,
    novels.fetchNextPage,
    novels.hasNextPage,
    novels.isFetchingNextPage,
    novels.isLoading,
  ]);
  const selectedNovelIds = Array.from(selectedIds);
  const selectedDownloadedChapterCount = rows.reduce(
    (total, novel) =>
      selectedIds.has(novel.id) ? total + novel.chaptersDownloaded : total,
    0,
  );
  const manualCategories = categories.data ?? [];
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
        : (manualCategories.find((category) => category.id === selectedCategoryId)
            ?.name ?? t("library.selectedCategory"));
  const categoryEditorTitle =
    categoryEditor?.mode === "rename"
      ? t("categories.rename")
      : t("categories.add");
  const categoryMutationError =
    createCategoryMutation.error ?? renameCategoryMutation.error;
  const categorySaving =
    createCategoryMutation.isPending || renameCategoryMutation.isPending;
  const status = t("library.status", {
    novels: summary.totalNovels,
    unread: stats.unreadChapters,
    downloaded: stats.downloadedChapters,
    total: stats.totalChapters,
  });
  const showMobileSearch = mobileSearchOpen || search.trim() !== "";
  const tags = getLibraryTags(summary, t);
  const sortLabel = t(SORT_LABEL_KEYS[sortOrder]);
  const activeCategoryCount =
    selectedCategoryId == null
      ? allCategoryCount
      : selectedCategoryId === UNCATEGORIZED_CATEGORY_ID
        ? uncategorizedCategoryCount
        : (manualCategories.find((category) => category.id === selectedCategoryId)
            ?.novelCount ?? 0);
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

  useEffect(() => {
    if (!active) return;

    const scrollElement = libraryBodyRef.current;
    if (!scrollElement) return;

    scrollElement.addEventListener("scroll", loadMoreIfNeeded, {
      passive: true,
    });
    window.addEventListener("resize", loadMoreIfNeeded);
    loadMoreIfNeeded();

    return () => {
      scrollElement.removeEventListener("scroll", loadMoreIfNeeded);
      window.removeEventListener("resize", loadMoreIfNeeded);
    };
  }, [active, loadMoreIfNeeded, rows.length]);

  const localImportMutation = useMutation({
    mutationFn: async (
      items: readonly LocalImportReviewItem[],
    ): Promise<LocalImportItemResult[]> => {
      const results: LocalImportItemResult[] = [];

      for (const item of items) {
        try {
          const result = await importLocalFileToLibrary(
            item.file,
            item.analysis,
          );
          results.push({ itemId: item.id, result, status: "imported" });
        } catch (error) {
          results.push({
            error: getLocalImportErrorMessage(error),
            itemId: item.id,
            status: "error",
          });
        } finally {
          clearLocalImportFileCache(item.file);
        }
      }

      return results;
    },
    onMutate: (items) => {
      const importingIds = new Set(items.map((item) => item.id));
      setLocalImportItems((current) =>
        current.map((item) =>
          importingIds.has(item.id) ? { ...item, status: "importing" } : item,
        ),
      );
    },
    onSuccess: (results) => {
      const resultById = new Map(
        results.map((result) => [result.itemId, result]),
      );
      setLocalImportItems((current) =>
        current.map((item) => {
          const result = resultById.get(item.id);
          if (!result) return item;

          if (result.status === "imported" && result.result) {
            return {
              ...item,
              error: undefined,
              importedChapterCount: result.result.chapterCount,
              importedNovelId: result.result.novelId,
              status: "imported",
            };
          }

          return {
            ...item,
            error: result.error ?? t("library.localImport.error"),
            status: "error",
          };
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel"] });

      const imported = results.filter(
        (
          result,
        ): result is LocalImportItemResult & {
          result: LocalNovelImportResult;
          status: "imported";
        } => result.status === "imported" && !!result.result,
      );
      if (results.length === 1 && imported.length === 1) {
        setLocalImportOpen(false);
        void navigate({
          to: "/novel",
          search: { id: imported[0].result.novelId },
        });
      }
    },
  });

  const createLocalNovelMutation = useMutation({
    mutationFn: (input: LocalNovelMetadataInput) =>
      upsertLocalNovelMetadata({
        ...input,
        path: createManualLocalNovelPath(),
      }),
    onSuccess: (novelId) => {
      setLocalNovelEditorOpen(false);
      setLocalNovelForm(EMPTY_LOCAL_NOVEL_FORM);
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
      void navigate({ to: "/novel", search: { id: novelId } });
    },
  });

  const openLocalImportInput = useCallback(() => {
    localImportMutation.reset();
    localImportInputRef.current?.click();
  }, [localImportMutation]);

  const closeLocalImportReview = useCallback(() => {
    if (localImportMutation.isPending) return;
    localImportMutation.reset();
    for (const item of localImportItems) {
      clearLocalImportFileCache(item.file);
    }
    setLocalImportOpen(false);
    setLocalImportItems([]);
  }, [localImportItems, localImportMutation]);

  const openLocalNovelEditor = useCallback(() => {
    createLocalNovelMutation.reset();
    setLocalNovelForm(EMPTY_LOCAL_NOVEL_FORM);
    setLocalNovelEditorOpen(true);
  }, [createLocalNovelMutation]);

  const closeLocalNovelEditor = useCallback(() => {
    if (createLocalNovelMutation.isPending) return;
    createLocalNovelMutation.reset();
    setLocalNovelEditorOpen(false);
    setLocalNovelForm(EMPTY_LOCAL_NOVEL_FORM);
  }, [createLocalNovelMutation]);

  const handleLocalNovelSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (localNovelForm.name.trim() === "") return;
      createLocalNovelMutation.mutate(localNovelForm);
    },
    [createLocalNovelMutation, localNovelForm],
  );

  const handleLocalImportFilesSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length === 0) return;

      localImportMutation.reset();
      for (const item of localImportItems) {
        clearLocalImportFileCache(item.file);
      }
      setLocalImportOpen(true);
      setLocalImportAnalyzing(true);
      setLocalImportItems([]);

      const analyzedItems = await Promise.all(
        files.map((file, index) => analyzeLocalImportReviewItem(file, index)),
      );
      setLocalImportItems(markSelectedLocalImportDuplicates(analyzedItems));
      setLocalImportAnalyzing(false);
    },
    [localImportItems, localImportMutation],
  );

  const readyLocalImportItems = localImportItems.filter(
    (item) => item.status === "ready",
  );
  const localImportSummary = localImportAnalyzing
    ? t("library.localImport.analyzing")
    : getLocalImportSummary(localImportItems, t);

  return (
    <>
      <PageFrame className="lnr-library-page" size="full">
        <div className="lnr-library-shell">
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
            className="lnr-library-main"
            aria-label={t("library.mainLabel")}
          >
            <header className="lnr-library-main-header">
              <div className="lnr-library-header-copy">
                <h1 className="lnr-library-title-heading">
                  <span className="lnr-library-title-static">
                    {activeCategory}
                  </span>
                  <UnstyledButton
                    aria-label={t("library.openCategories", {
                      name: activeCategory,
                    })}
                    className="lnr-library-title-button"
                    onClick={() => setCategoriesOpen(true)}
                    title={activeCategory}
                  >
                    <span>{activeCategory}</span>
                  </UnstyledButton>
                </h1>
                <span className="lnr-library-header-meta">
                  {t("library.sortedMeta", {
                    count: summary.totalNovels,
                    sort: sortLabel.toLowerCase(),
                  })}
                </span>
              </div>
              <div className="lnr-library-header-actions">
                <IconButton
                  active={showMobileSearch}
                  aria-controls="library-mobile-search"
                  aria-expanded={showMobileSearch}
                  className="lnr-library-mobile-search-button"
                  label={t("library.search.aria")}
                  onClick={() => setMobileSearchOpen((open) => !open)}
                  size="sm"
                  title={t("library.search.placeholder")}
                >
                  <SearchIcon />
                </IconButton>
                <UnstyledButton
                  className="lnr-library-mobile-category-button"
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
                  className="lnr-library-icon-button lnr-library-local-import-button"
                  label={t("library.localImport.open")}
                  onClick={openLocalImportInput}
                  size="sm"
                  title={t("library.localImport.open")}
                >
                  <ImportFileIcon />
                </IconButton>
                <IconButton
                  className="lnr-library-icon-button"
                  label={t("library.localNovel.create")}
                  onClick={openLocalNovelEditor}
                  size="sm"
                  title={t("library.localNovel.create")}
                >
                  <PlusGlyph />
                </IconButton>
                <IconButton
                  className="lnr-library-icon-button lnr-library-refresh-button"
                  disabled={
                    activeCategoryCount === 0 ||
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
                      className="lnr-library-icon-button"
                      label={t("library.settings.open")}
                      size="sm"
                      title={t("library.settings.title")}
                    >
                      <SlidersIcon />
                    </IconButton>
                  </Popover.Target>
                  <Popover.Dropdown className="lnr-library-settings-popover">
                    <LibrarySettingsPanel />
                  </Popover.Dropdown>
                </Popover>
              </div>
            </header>
            {showMobileSearch ? (
              <div
                className="lnr-library-mobile-search-row"
                id="library-mobile-search"
              >
                <LibraryCommandSearch value={search} onChange={setSearch} />
              </div>
            ) : null}

            {selectedIds.size > 0 ? (
              <div className="lnr-library-selection-strip">
                <span>{t("library.selectedCount", { count: selectedIds.size })}</span>
                <div className="lnr-library-selection-actions">
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
                    className="lnr-library-selection-icon"
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
                    className="lnr-library-selection-icon"
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
                      removeSelectedFromLibraryMutation.mutate(selectedNovelIds);
                    }}
                    size="sm"
                    title={t("library.removeSelectedFromLibrary")}
                    tone="danger"
                  >
                    {removeSelectedFromLibraryMutation.isPending ? (
                      <Loader size={14} />
                    ) : (
                      <TrashIcon />
                    )}
                  </IconButton>
                  <UnstyledButton onClick={clearSelection}>
                    {t("common.done")}
                  </UnstyledButton>
                </div>
              </div>
            ) : null}

            <div className="lnr-library-body" ref={libraryBodyRef}>
              {isInitialLibraryLoading ? (
                <StateView
                  title={
                    <span className="lnr-library-loading-title">
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
                    <div className="lnr-library-load-more">
                      <TextButton
                        className="lnr-library-load-more-action"
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

            <ConsoleStatusStrip className="lnr-library-status-strip">
              <span>{status}</span>
              <span>{t("library.statusUpdated", { time: stats.lastUpdatedLabel })}</span>
              <span>{activeCategory}</span>
              <span>{t("library.statusSort", { sort: sortLabel })}</span>
              {metadataRefreshStatus ? (
                <span>{metadataRefreshStatus}</span>
              ) : null}
            </ConsoleStatusStrip>
          </section>
        </div>
      </PageFrame>

      <input
        ref={localImportInputRef}
        accept={LOCAL_IMPORT_ACCEPT}
        className="lnr-library-file-input"
        multiple
        onChange={handleLocalImportFilesSelected}
        type="file"
      />

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

      <Modal
        opened={active && localImportOpen}
        onClose={closeLocalImportReview}
        size="lg"
        title={t("library.localImport.title")}
      >
        <Stack gap="sm">
          {localImportAnalyzing ? (
            <Group gap="xs">
              <Loader size="sm" />
              <Text c="dimmed" size="sm">
                {t("library.localImport.analyzing")}
              </Text>
            </Group>
          ) : null}

          {localImportItems.length > 0 ? (
            <div className="lnr-library-local-import-list">
              {localImportItems.map((item) => (
                <LocalImportReviewRow
                  item={item}
                  key={item.id}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
          ) : null}

          {localImportMutation.error ? (
            <Text c="red" size="sm">
              {getLocalImportErrorMessage(localImportMutation.error)}
            </Text>
          ) : null}

          <Group justify="space-between" wrap="wrap">
            <Text c="dimmed" size="sm">
              {localImportSummary}
            </Text>
            <Group gap="xs">
              <TextButton
                disabled={localImportMutation.isPending}
                onClick={closeLocalImportReview}
                type="button"
                variant="subtle"
              >
                {t("common.cancel")}
              </TextButton>
              <TextButton
                disabled={
                  localImportAnalyzing ||
                  readyLocalImportItems.length === 0 ||
                  localImportMutation.isPending
                }
                loading={localImportMutation.isPending}
                onClick={() =>
                  localImportMutation.mutate(readyLocalImportItems)
                }
                type="button"
              >
                {t("library.localImport.importReady", {
                  count: readyLocalImportItems.length,
                })}
              </TextButton>
            </Group>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={active && localNovelEditorOpen}
        onClose={closeLocalNovelEditor}
        size="lg"
        title={t("library.localNovel.title")}
      >
        <form onSubmit={handleLocalNovelSubmit}>
          <Stack gap="sm">
            <TextInput
              autoFocus
              label={t("library.localNovel.name")}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setLocalNovelForm((current) => ({
                  ...current,
                  name: value,
                }));
              }}
              required
              value={localNovelForm.name}
            />
            <Group grow>
              <TextInput
                label={t("library.localNovel.author")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalNovelForm((current) => ({
                    ...current,
                    author: value,
                  }));
                }}
                value={localNovelForm.author ?? ""}
              />
              <TextInput
                label={t("library.localNovel.artist")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalNovelForm((current) => ({
                    ...current,
                    artist: value,
                  }));
                }}
                value={localNovelForm.artist ?? ""}
              />
            </Group>
            <Group grow>
              <TextInput
                label={t("library.localNovel.status")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalNovelForm((current) => ({
                    ...current,
                    status: value,
                  }));
                }}
                value={localNovelForm.status ?? ""}
              />
              <TextInput
                label={t("library.localNovel.genres")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalNovelForm((current) => ({
                    ...current,
                    genres: value,
                  }));
                }}
                value={localNovelForm.genres ?? ""}
              />
            </Group>
            <LocalCoverPicker
              alt={localNovelForm.name || t("library.localNovel.name")}
              disabled={createLocalNovelMutation.isPending}
              onChange={(cover) =>
                setLocalNovelForm((current) => ({
                  ...current,
                  cover,
                }))
              }
              value={localNovelForm.cover}
            />
            <Textarea
              autosize
              label={t("library.localNovel.summary")}
              minRows={4}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setLocalNovelForm((current) => ({
                  ...current,
                  summary: value,
                }));
              }}
              value={localNovelForm.summary ?? ""}
            />
            {createLocalNovelMutation.error ? (
              <Text c="red" size="sm">
                {getLocalImportErrorMessage(createLocalNovelMutation.error)}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <TextButton
                disabled={createLocalNovelMutation.isPending}
                onClick={closeLocalNovelEditor}
                type="button"
                variant="subtle"
              >
                {t("common.cancel")}
              </TextButton>
              <TextButton
                disabled={
                  localNovelForm.name.trim() === "" ||
                  createLocalNovelMutation.isPending
                }
                loading={createLocalNovelMutation.isPending}
                type="submit"
              >
                {t("library.localNovel.create")}
              </TextButton>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        opened={active && categoryEditor !== null}
        onClose={closeCategoryEditor}
        title={categoryEditorTitle}
      >
        <form onSubmit={handleCategorySubmit}>
          <Stack gap="sm">
            <TextInput
              autoFocus
              label={t("library.categoryName")}
              onChange={(event) => setCategoryName(event.currentTarget.value)}
              value={categoryName}
            />
            {categoryMutationError ? (
              <Text c="red" size="sm">
                {categoryMutationError instanceof Error
                  ? categoryMutationError.message
                  : String(categoryMutationError)}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <TextButton
                type="button"
                variant="subtle"
                onClick={closeCategoryEditor}
              >
                {t("common.cancel")}
              </TextButton>
              <TextButton
                disabled={categoryName.trim() === ""}
                loading={categorySaving}
                type="submit"
              >
                {t("common.save")}
              </TextButton>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        opened={active && categoryDeleteTarget !== null}
        onClose={() => {
          deleteCategoryMutation.reset();
          setCategoryDeleteTarget(null);
        }}
        title={t("categories.delete")}
      >
        <Stack gap="sm">
          <Text size="sm">
            {categoryDeleteTarget
              ? t("library.deleteCategory.message", {
                  name: categoryDeleteTarget.name,
                })
              : ""}
          </Text>
          {deleteCategoryMutation.error ? (
            <Text c="red" size="sm">
              {deleteCategoryMutation.error instanceof Error
                ? deleteCategoryMutation.error.message
                : String(deleteCategoryMutation.error)}
            </Text>
          ) : null}
          <Group justify="flex-end">
            <TextButton
              type="button"
              variant="subtle"
              onClick={() => {
                deleteCategoryMutation.reset();
                setCategoryDeleteTarget(null);
              }}
            >
              {t("common.cancel")}
            </TextButton>
            <TextButton
              loading={deleteCategoryMutation.isPending}
              tone="danger"
              onClick={() => {
                if (categoryDeleteTarget) {
                  deleteCategoryMutation.mutate(categoryDeleteTarget.id);
                }
              }}
            >
              {t("common.delete")}
            </TextButton>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

interface LibraryScopeFiltersProps {
  downloadedOnly: boolean;
  onDownloadedOnlyChange: (value: boolean) => void;
  onUnreadOnlyChange: (value: boolean) => void;
  t: TranslateFn;
  unreadOnly: boolean;
}

function LibraryScopeFilters({
  downloadedOnly,
  onDownloadedOnlyChange,
  onUnreadOnlyChange,
  t,
  unreadOnly,
}: LibraryScopeFiltersProps) {
  return (
    <div
      className="lnr-library-filter-toggle"
      role="group"
      aria-label={t("library.filters.label")}
    >
      <Tooltip label={t("library.downloadedOnly")} openDelay={350} withArrow>
        <IconButton
          active={downloadedOnly}
          aria-pressed={downloadedOnly}
          className="lnr-library-filter-button"
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
          className="lnr-library-filter-button"
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

interface CategorySubpanelProps {
  activeId: number | null;
  allCount: number;
  categories: readonly LibraryCategory[];
  error: unknown;
  loading: boolean;
  onCreate: () => void;
  onDelete: (category: LibraryCategory) => void;
  onOpenDrawer: () => void;
  onRename: (category: LibraryCategory) => void;
  onSelect: (id: number | null) => void;
  tags: readonly LibraryTag[];
  t: TranslateFn;
  uncategorizedCount: number;
}

function CategorySubpanel({
  activeId,
  allCount,
  categories,
  error,
  loading,
  onCreate,
  onDelete,
  onOpenDrawer,
  onRename,
  onSelect,
  tags,
  t,
  uncategorizedCount,
}: CategorySubpanelProps) {
  return (
    <aside className="lnr-library-subpanel" aria-label={t("categories.title")}>
      <div className="lnr-library-subpanel-header">
        <Text className="lnr-console-kicker">{t("categories.title")}</Text>
        <Tooltip label={t("categories.add")} openDelay={350} withArrow>
          <IconButton
            className="lnr-library-subpanel-icon"
            label={t("categories.add")}
            onClick={onCreate}
            size="sm"
            title={t("categories.add")}
          >
            <PlusIcon />
          </IconButton>
        </Tooltip>
      </div>
      <ScrollArea className="lnr-library-category-scroll">
        <div className="lnr-library-category-list">
            <CategoryButton
              active={activeId === null}
              count={allCount}
              label={t("categories.all")}
              onClick={() => onSelect(null)}
              t={t}
            />
            <CategoryButton
              active={activeId === UNCATEGORIZED_CATEGORY_ID}
              count={uncategorizedCount}
              label={t("categories.uncategorized")}
              onClick={() => onSelect(UNCATEGORIZED_CATEGORY_ID)}
              t={t}
            />
          {loading ? (
            <Text className="lnr-library-subpanel-note">{t("common.loading")}</Text>
          ) : error ? (
            <Text className="lnr-library-subpanel-note" c="red">
              {error instanceof Error ? error.message : String(error)}
            </Text>
          ) : categories.length > 0 ? (
            categories.map((category) => (
              <CategoryButton
                key={category.id}
                active={activeId === category.id}
                canEdit={!category.isSystem}
                count={category.novelCount}
                label={category.name}
                onDelete={() => onDelete(category)}
                onRename={() => onRename(category)}
                onClick={() => onSelect(category.id)}
                t={t}
              />
            ))
          ) : (
            <Text className="lnr-library-subpanel-note">
              {t("categories.noManual")}
            </Text>
          )}

          <div className="lnr-library-tags">
            <div className="lnr-library-tags-title">{t("library.tags.title")}</div>
            {tags.length > 0 ? (
              tags.map((tag) => (
                <div className="lnr-library-tag-row" key={tag.label}>
                  <span>{`#${tag.label}`}</span>
                  <span>{tag.count}</span>
                </div>
              ))
            ) : (
              <Text className="lnr-library-subpanel-note">
                {t("library.tags.none")}
              </Text>
            )}
          </div>
        </div>
      </ScrollArea>
      <div className="lnr-library-subpanel-footer">
        <span>{t("library.footer.shortcuts")}</span>
        <UnstyledButton onClick={onOpenDrawer}>
          {t("library.manageCategories")}
        </UnstyledButton>
      </div>
    </aside>
  );
}

interface CategoryButtonProps {
  active: boolean;
  canEdit?: boolean;
  count?: number;
  label: string;
  onDelete?: () => void;
  onRename?: () => void;
  onClick: () => void;
  t: TranslateFn;
}

function CategoryButton({
  active,
  canEdit = false,
  count,
  label,
  onDelete,
  onRename,
  onClick,
  t,
}: CategoryButtonProps) {
  return (
    <div className="lnr-library-category-row" data-active={active}>
      <UnstyledButton
        className="lnr-library-category"
        data-active={active}
        onClick={onClick}
      >
        <span className="lnr-library-category-label">{label}</span>
      </UnstyledButton>
      {canEdit ? (
        <span className="lnr-library-category-actions">
          <Tooltip label={t("categories.rename")} openDelay={350} withArrow>
            <IconButton
              className="lnr-library-category-action"
              label={t("categories.renameNamed", { name: label })}
              onClick={onRename}
              size="sm"
              title={t("categories.rename")}
            >
              <EditIcon />
            </IconButton>
          </Tooltip>
          <Tooltip label={t("categories.delete")} openDelay={350} withArrow>
            <IconButton
              className="lnr-library-category-action"
              label={t("categories.deleteNamed", { name: label })}
              onClick={onDelete}
              size="sm"
              title={t("categories.delete")}
            >
              <TrashIcon />
            </IconButton>
          </Tooltip>
        </span>
      ) : null}
      <span className="lnr-library-category-count">{count ?? 0}</span>
    </div>
  );
}

interface SelectionCategoryPickerProps {
  assigning: boolean;
  categories: readonly LibraryCategory[];
  onAssign: (categoryId: number) => void;
  t: TranslateFn;
}

function LibraryBatchDownloadPicker({
  onDownload,
  preparing,
  t,
}: LibraryBatchDownloadPickerProps) {
  const [opened, setOpened] = useState(false);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      width={280}
    >
      <Popover.Target>
        <IconButton
          className="lnr-library-selection-icon"
          disabled={preparing}
          label={t("library.batchDownload.open")}
          onClick={() => setOpened((current) => !current)}
          size="sm"
          title={t("library.batchDownload.open")}
        >
          <DownloadGlyph />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="lnr-library-batch-download-popover">
        <div className="lnr-library-batch-download-list">
          {LIBRARY_BATCH_DOWNLOAD_OPTIONS.map((option) => (
            <UnstyledButton
              className="lnr-library-batch-download-option"
              disabled={preparing}
              key={option.mode}
              onClick={() => {
                onDownload(option.mode);
                setOpened(false);
              }}
            >
              <span className="lnr-library-batch-download-label">
                {t(option.labelKey)}
              </span>
              <span className="lnr-library-batch-download-description">
                {t(option.descriptionKey)}
              </span>
            </UnstyledButton>
          ))}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

function SelectionCategoryPicker({
  assigning,
  categories,
  onAssign,
  t,
}: SelectionCategoryPickerProps) {
  return (
    <Popover position="bottom-end" shadow="md" width={220}>
      <Popover.Target>
        <IconButton
          className="lnr-library-selection-icon"
          disabled={categories.length === 0 || assigning}
          label={t("library.addSelectedToCategory")}
          size="sm"
          title={t("library.addSelectedToCategory")}
        >
          <FolderPlusIcon />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="lnr-library-category-assign-popover">
        <div className="lnr-library-category-assign-list">
          {categories.length > 0 ? (
            categories.map((category) => (
              <UnstyledButton
                className="lnr-library-category-assign-option"
                disabled={assigning}
                key={category.id}
                onClick={() => onAssign(category.id)}
              >
                <span>{category.name}</span>
              </UnstyledButton>
            ))
          ) : (
            <Text c="dimmed" size="sm">
              {t("library.addCategoryFirst")}
            </Text>
          )}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

interface LocalImportReviewRowProps {
  item: LocalImportReviewItem;
  locale: ReturnType<typeof useTranslation>["locale"];
  t: TranslateFn;
}

function LocalImportReviewRow({
  item,
  locale,
  t,
}: LocalImportReviewRowProps) {
  const title = item.analysis?.title ?? item.file.name;
  const detail = getLocalImportStatusDetail(item, t);
  const meta = [
    item.file.name,
    item.format
      ? item.format.toUpperCase()
      : t("library.localImport.formatUnknown"),
    formatLocalImportFileSize(item.file.size, locale),
  ].join(" - ");

  return (
    <div className="lnr-library-local-import-row" data-status={item.status}>
      <div className="lnr-library-local-import-file">
        <span className="lnr-library-local-import-title">{title}</span>
        <span className="lnr-library-local-import-meta">{meta}</span>
        {detail ? (
          <span className="lnr-library-local-import-detail">{detail}</span>
        ) : null}
      </div>
      <span className="lnr-library-local-import-status">
        {getLocalImportStatusLabel(item.status, t)}
      </span>
    </div>
  );
}

interface LibraryCommandSearchProps {
  onChange: (value: string) => void;
  value: string;
}

function LibraryCommandSearch({
  onChange,
  value,
}: LibraryCommandSearchProps) {
  const { t } = useTranslation();

  return (
    <label className="lnr-library-command-search">
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

function ViewModeToggle({ displayMode, onChange, t }: ViewModeToggleProps) {
  return (
    <div
      className="lnr-library-view-toggle"
      role="group"
      aria-label={t("library.viewMode.label")}
    >
      {VIEW_MODE_OPTIONS.map((option) => {
        const label = t(option.labelKey);
        return (
          <IconButton
            active={displayMode === option.mode}
            className="lnr-library-view-button"
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

function MobileViewModePicker({
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
          className="lnr-library-mobile-view-button"
          label={t("library.viewMode.label")}
          size="sm"
          title={activeLabel}
        >
          <ViewModeIcon icon={activeOption.icon} />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="lnr-library-mobile-view-menu">
        {VIEW_MODE_OPTIONS.map((option) => {
          const label = t(option.labelKey);
          return (
            <UnstyledButton
              className="lnr-library-mobile-view-option"
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

function LibrarySortPicker({
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
          className="lnr-library-icon-button lnr-library-sort-button"
          data-sort-direction={sortDirection}
          label={t("librarySettings.sort")}
          onClick={() => setOpened((current) => !current)}
          size="sm"
          title={activeLabel}
        >
          <SortGlyph />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="lnr-library-sort-menu">
        {LIBRARY_SORT_ORDERS.map((value) => {
          const label = t(SORT_LABEL_KEYS[value]);
          return (
            <UnstyledButton
              className="lnr-library-sort-option"
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

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 20h4" />
      <path d="M14 5l5 5" />
      <path d="M17 3l4 4L9 19H5v-4z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 14h10l1-14" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 6h6l2 2h8v10H4z" />
      <path d="M12 13h6" />
      <path d="M15 10v6" />
    </svg>
  );
}

function ImportFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M12 11v6" />
      <path d="M9 14l3 3 3-3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function SlidersIcon() {
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

async function analyzeLocalImportReviewItem(
  file: File,
  index: number,
): Promise<LocalImportReviewItem> {
  const id = `${file.name}:${file.size}:${file.lastModified}:${index}`;

  try {
    const analysis = await analyzeLocalImportFile(file);
    const existingNovel = await findLocalNovelByPath(analysis.pathKey);

    return {
      analysis,
      duplicateKind: existingNovel ? "library" : undefined,
      existingNovelId: existingNovel?.id,
      file,
      format: analysis.format,
      id,
      status: existingNovel ? "duplicate" : "ready",
    };
  } catch (error) {
    return {
      error: getLocalImportErrorMessage(error),
      file,
      id,
      status: isUnsupportedLocalImportError(error) ? "unsupported" : "error",
    };
  }
}

function markSelectedLocalImportDuplicates(
  items: readonly LocalImportReviewItem[],
): LocalImportReviewItem[] {
  const seenPathKeys = new Set<string>();

  return items.map((item) => {
    if (item.status !== "ready" || !item.analysis) return item;
    if (seenPathKeys.has(item.analysis.pathKey)) {
      return {
        ...item,
        duplicateKind: "selection",
        status: "duplicate",
      };
    }

    seenPathKeys.add(item.analysis.pathKey);
    return item;
  });
}

async function importLocalFileToLibrary(
  file: File,
  analysis?: LocalImportAnalysis,
): Promise<LocalNovelImportResult> {
  const conversion = await convertLocalImportFile(file, { analysis });
  const chapters = conversion.chapters.map((chapter, index) => ({
    chapterNumber:
      chapter.chapterNumber == null ? null : String(chapter.chapterNumber),
    content: chapter.content,
    binaryResource: chapter.binaryResource,
    contentBytes: chapter.contentBytes,
    contentType: chapter.contentType,
    mediaResources: chapter.mediaResources,
    name: chapter.name,
    page: chapter.page,
    path: chapter.path,
    position: index + 1,
    releaseTime: chapter.releaseTime ?? null,
  }));

  const previousNovel = await findLocalNovelByPath(conversion.novel.path);
  const previousChapters = previousNovel
    ? await listChaptersByNovel(previousNovel.id)
    : [];
  const result = await upsertLocalNovel({
    artist: conversion.novel.artist ?? null,
    author: conversion.novel.author ?? null,
    chapters,
    cover: conversion.novel.cover ?? null,
    genres: conversion.novel.genres ?? null,
    name: conversion.novel.name,
    path: conversion.novel.path,
    status: conversion.novel.status ?? null,
    summary: conversion.novel.summary ?? null,
  });
  const nextNovel = await getNovelById(result.novelId);
  if (previousNovel && nextNovel?.isLocal) {
    const nextChapters = await listChaptersByNovel(result.novelId);
    await syncLocalChapterStorageAfterOrderChange({
      nextChapters,
      novel: nextNovel,
      previousChapters,
      previousNovel,
    });
  }
  await cacheLocalImportedChapterMedia({
    chapters,
    novelId: result.novelId,
    novelName: conversion.novel.name,
    novelPath: conversion.novel.path,
  });
  await mirrorStoredNovelChapters(result.novelId);
  return result;
}

function createManualLocalNovelPath(): string {
  const id =
    globalThis.crypto && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `local:manual:${id}`;
}

function getLocalImportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedLocalImportError(error: unknown): boolean {
  return (
    error instanceof LocalImportError &&
    error.message.startsWith("Unsupported local import format:")
  );
}

function getLocalImportStatusLabel(
  status: LocalImportReviewStatus,
  t: TranslateFn,
): string {
  switch (status) {
    case "ready":
      return t("library.localImport.status.ready");
    case "duplicate":
      return t("library.localImport.status.duplicate");
    case "unsupported":
      return t("library.localImport.status.unsupported");
    case "error":
      return t("library.localImport.status.error");
    case "importing":
      return t("library.localImport.status.importing");
    case "imported":
      return t("library.localImport.status.imported");
  }
}

function getLocalImportStatusDetail(
  item: LocalImportReviewItem,
  t: TranslateFn,
): string | null {
  if (item.status === "duplicate") {
    return item.duplicateKind === "selection"
      ? t("library.localImport.duplicateSelected")
      : t("library.localImport.duplicateLibrary");
  }

  if (item.status === "unsupported" || item.status === "error") {
    return item.error ?? t("library.localImport.error");
  }

  if (item.status === "imported") {
    return t("library.localImport.importedDetail", {
      count: item.importedChapterCount ?? 0,
    });
  }

  return null;
}

function getLocalImportSummary(
  items: readonly LocalImportReviewItem[],
  t: TranslateFn,
): string {
  if (items.length === 0) return t("library.localImport.empty");

  const ready = items.filter((item) => item.status === "ready").length;
  const imported = items.filter((item) => item.status === "imported").length;
  const blocked = items.filter(
    (item) =>
      item.status === "duplicate" ||
      item.status === "unsupported" ||
      item.status === "error",
  ).length;

  return t("library.localImport.summary", {
    blocked,
    imported,
    ready,
    total: items.length,
  });
}

function formatLocalImportFileSize(
  bytes: number,
  locale: ReturnType<typeof useTranslation>["locale"],
): string {
  if (bytes < 1024) {
    return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  }

  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value)} ${units[unitIndex]}`;
}

interface LibraryTag {
  count: number;
  label: string;
}

function getLibraryTags(
  summary: LibraryNovelSummary,
  t: TranslateFn,
): LibraryTag[] {
  return [
    { count: summary.unreadNovels, label: t("library.tags.unread") },
    { count: summary.downloadedNovels, label: t("library.tags.downloaded") },
    { count: summary.localNovels, label: t("library.tags.local") },
    { count: summary.completeNovels, label: t("library.tags.complete") },
  ].filter((tag) => tag.count > 0);
}

function getLibraryStats(
  summary: LibraryNovelSummary,
  locale: ReturnType<typeof useTranslation>["locale"],
) {
  return {
    downloadedChapters: summary.downloadedChapters,
    lastUpdatedLabel: formatRelativeTimeForLocale(locale, summary.lastUpdatedAt),
    totalChapters: summary.totalChapters,
    unreadChapters: summary.unreadChapters,
  };
}
