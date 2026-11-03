import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LibraryDisplayMode =
  | "compact"
  | "comfortable"
  | "cover-only"
  | "list";

export type LibrarySortOrder =
  | "nameAsc"
  | "nameDesc"
  | "downloadedAsc"
  | "downloadedDesc"
  | "undownloadedAsc"
  | "undownloadedDesc"
  | "totalChaptersAsc"
  | "totalChaptersDesc"
  | "unreadChaptersAsc"
  | "unreadChaptersDesc"
  | "dateAddedAsc"
  | "dateAddedDesc"
  | "lastReadAsc"
  | "lastReadDesc"
  | "lastUpdatedAsc"
  | "lastUpdatedDesc";

export type DefaultChapterSort = "asc" | "desc";

/** Hours between automatic checks for new chapters in novels being read; 0 turns them off. */
export const CHECK_INTERVAL_CHOICES = [0, 6, 12, 24] as const;
export type CheckIntervalHours = (typeof CHECK_INTERVAL_CHOICES)[number];
export const DEFAULT_CHECK_INTERVAL_HOURS: CheckIntervalHours = 12;

export function normalizeCheckIntervalHours(value: unknown): CheckIntervalHours {
  return CHECK_INTERVAL_CHOICES.find((choice) => choice === value) ?? DEFAULT_CHECK_INTERVAL_HOURS;
}

interface LibraryState {
  pendingLocalImportFiles: readonly File[];
  selectedCategoryId: number | null;
  defaultCategoryId: number | null;
  librarySessionInitialized: boolean;
  search: string;
  displayMode: LibraryDisplayMode;
  novelsPerRow: number;
  sortOrder: LibrarySortOrder;
  showDownloadBadges: boolean;
  showUnreadBadges: boolean;
  showNumberBadges: boolean;
  showContinueReading: boolean;
  continueReadingCollapsed: boolean;
  downloadedOnlyMode: boolean;
  unreadOnlyMode: boolean;
  localOnlyMode: boolean;
  completedOnlyMode: boolean;
  repairNeededOnlyMode: boolean;
  incognitoMode: boolean;
  defaultChapterSort: DefaultChapterSort;
  checkIntervalHours: CheckIntervalHours;
  queueLocalImportFiles: (files: readonly File[]) => void;
  takePendingLocalImportFiles: () => File[];
  setSelectedCategoryId: (id: number | null) => void;
  setDefaultCategoryId: (id: number | null) => void;
  enterLibrary: () => void;
  setSearch: (search: string) => void;
  setDisplayMode: (displayMode: LibraryDisplayMode) => void;
  setNovelsPerRow: (novelsPerRow: number) => void;
  setSortOrder: (sortOrder: LibrarySortOrder) => void;
  setShowDownloadBadges: (showDownloadBadges: boolean) => void;
  setShowUnreadBadges: (showUnreadBadges: boolean) => void;
  setShowNumberBadges: (showNumberBadges: boolean) => void;
  setShowContinueReading: (showContinueReading: boolean) => void;
  setContinueReadingCollapsed: (continueReadingCollapsed: boolean) => void;
  setDownloadedOnlyMode: (downloadedOnlyMode: boolean) => void;
  setUnreadOnlyMode: (unreadOnlyMode: boolean) => void;
  setLocalOnlyMode: (localOnlyMode: boolean) => void;
  setCompletedOnlyMode: (completedOnlyMode: boolean) => void;
  setRepairNeededOnlyMode: (repairNeededOnlyMode: boolean) => void;
  clearFilters: () => void;
  setIncognitoMode: (incognitoMode: boolean) => void;
  setDefaultChapterSort: (defaultChapterSort: DefaultChapterSort) => void;
  setCheckIntervalHours: (hours: number) => void;
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      pendingLocalImportFiles: [],
      selectedCategoryId: null,
      defaultCategoryId: null,
      librarySessionInitialized: false,
      search: "",
      displayMode: "comfortable",
      novelsPerRow: 3,
      sortOrder: "dateAddedDesc",
      showDownloadBadges: true,
      showUnreadBadges: true,
      showNumberBadges: false,
      showContinueReading: true,
      continueReadingCollapsed: false,
      downloadedOnlyMode: false,
      unreadOnlyMode: false,
      localOnlyMode: false,
      completedOnlyMode: false,
      repairNeededOnlyMode: false,
      incognitoMode: false,
      defaultChapterSort: "asc",
      checkIntervalHours: DEFAULT_CHECK_INTERVAL_HOURS,
      queueLocalImportFiles: (files) =>
        set((state) => ({
          pendingLocalImportFiles: [...state.pendingLocalImportFiles, ...files],
        })),
      takePendingLocalImportFiles: () => {
        const files = [...get().pendingLocalImportFiles];
        set({ pendingLocalImportFiles: [] });
        return files;
      },
      setSelectedCategoryId: (selectedCategoryId) =>
        set({ selectedCategoryId, librarySessionInitialized: true }),
      setDefaultCategoryId: (defaultCategoryId) => set({ defaultCategoryId }),
      enterLibrary: () => {
        if (get().librarySessionInitialized) return;
        if (useLibraryStore.persist && !useLibraryStore.persist.hasHydrated()) return;
        set({
          selectedCategoryId: get().defaultCategoryId,
          librarySessionInitialized: true,
        });
      },
      setSearch: (search) => set({ search }),
      setDisplayMode: (displayMode) => set({ displayMode }),
      setNovelsPerRow: (novelsPerRow) =>
        set({ novelsPerRow: Math.max(1, Math.min(5, novelsPerRow)) }),
      setSortOrder: (sortOrder) => set({ sortOrder }),
      setShowDownloadBadges: (showDownloadBadges) =>
        set({ showDownloadBadges }),
      setShowUnreadBadges: (showUnreadBadges) =>
        set({ showUnreadBadges }),
      setShowNumberBadges: (showNumberBadges) =>
        set({ showNumberBadges }),
      setShowContinueReading: (showContinueReading) =>
        set({ showContinueReading }),
      setContinueReadingCollapsed: (continueReadingCollapsed) =>
        set({ continueReadingCollapsed }),
      setDownloadedOnlyMode: (downloadedOnlyMode) =>
        set({ downloadedOnlyMode }),
      setUnreadOnlyMode: (unreadOnlyMode) =>
        set((state) => ({
          unreadOnlyMode,
          completedOnlyMode: unreadOnlyMode ? false : state.completedOnlyMode,
        })),
      setLocalOnlyMode: (localOnlyMode) => set({ localOnlyMode }),
      setCompletedOnlyMode: (completedOnlyMode) =>
        set((state) => ({
          completedOnlyMode,
          unreadOnlyMode: completedOnlyMode ? false : state.unreadOnlyMode,
        })),
      setRepairNeededOnlyMode: (repairNeededOnlyMode) => set({ repairNeededOnlyMode }),
      clearFilters: () =>
        set({
          downloadedOnlyMode: false,
          unreadOnlyMode: false,
          localOnlyMode: false,
          completedOnlyMode: false,
          repairNeededOnlyMode: false,
        }),
      setIncognitoMode: (incognitoMode) => set({ incognitoMode }),
      setDefaultChapterSort: (defaultChapterSort) =>
        set({ defaultChapterSort }),
      setCheckIntervalHours: (hours) =>
        set({ checkIntervalHours: normalizeCheckIntervalHours(hours) }),
    }),
    {
      name: "norea-library-settings",
      partialize: (state) => ({
        displayMode: state.displayMode,
        novelsPerRow: state.novelsPerRow,
        sortOrder: state.sortOrder,
        showDownloadBadges: state.showDownloadBadges,
        showUnreadBadges: state.showUnreadBadges,
        showNumberBadges: state.showNumberBadges,
        showContinueReading: state.showContinueReading,
        continueReadingCollapsed: state.continueReadingCollapsed,
        downloadedOnlyMode: state.downloadedOnlyMode,
        unreadOnlyMode: state.unreadOnlyMode,
        localOnlyMode: state.localOnlyMode,
        completedOnlyMode: state.completedOnlyMode,
        repairNeededOnlyMode: state.repairNeededOnlyMode,
        defaultCategoryId: state.defaultCategoryId,
        incognitoMode: state.incognitoMode,
        defaultChapterSort: state.defaultChapterSort,
        checkIntervalHours: state.checkIntervalHours,
      }),
    },
  ),
);
