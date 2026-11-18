import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isNovelStatus, type NovelStatusValue } from "../lib/plugins/types";

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

function sanitizeStatusList(raw: unknown): NovelStatusValue[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<NovelStatusValue>();
  for (const item of raw) {
    if (isNovelStatus(item) && !seen.has(item)) seen.add(item);
  }
  return [...seen];
}

function sanitizeTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim().replace(/^#+/, "").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(cleaned);
  }
  return tags;
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
  selectedStatuses: NovelStatusValue[];
  selectedTags: string[];
  incognitoMode: boolean;
  defaultChapterSort: DefaultChapterSort;
  checkIntervalHours: CheckIntervalHours;
  /** Completed works skip the automatic and on-open checks for new chapters. */
  skipCompletedChecks: boolean;
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
  setSelectedStatuses: (statuses: readonly string[]) => void;
  toggleStatus: (status: string) => void;
  setSelectedTags: (tags: readonly string[]) => void;
  toggleTag: (tag: string) => void;
  clearFilters: () => void;
  setIncognitoMode: (incognitoMode: boolean) => void;
  setDefaultChapterSort: (defaultChapterSort: DefaultChapterSort) => void;
  setCheckIntervalHours: (hours: number) => void;
  setSkipCompletedChecks: (skipCompletedChecks: boolean) => void;
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
      selectedStatuses: [],
      selectedTags: [],
      incognitoMode: false,
      defaultChapterSort: "asc",
      checkIntervalHours: DEFAULT_CHECK_INTERVAL_HOURS,
      skipCompletedChecks: true,
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
      setSelectedStatuses: (statuses) =>
        set({ selectedStatuses: sanitizeStatusList(statuses) }),
      toggleStatus: (status) => {
        if (!isNovelStatus(status)) return;
        set((state) => ({
          selectedStatuses: state.selectedStatuses.includes(status)
            ? state.selectedStatuses.filter((item) => item !== status)
            : [...state.selectedStatuses, status],
        }));
      },
      setSelectedTags: (tags) =>
        set({ selectedTags: sanitizeTagList(tags) }),
      toggleTag: (tag) => {
        const normalized = sanitizeTagList([tag]);
        if (normalized.length === 0) return;
        const target = normalized[0]!;
        const targetKey = target.toLowerCase();
        set((state) => {
          const exists = state.selectedTags.some((item) => item.toLowerCase() === targetKey);
          return {
            selectedTags: exists
              ? state.selectedTags.filter((item) => item.toLowerCase() !== targetKey)
              : [...state.selectedTags, target],
          };
        });
      },
      clearFilters: () =>
        set({
          downloadedOnlyMode: false,
          unreadOnlyMode: false,
          localOnlyMode: false,
          completedOnlyMode: false,
          repairNeededOnlyMode: false,
          selectedStatuses: [],
          selectedTags: [],
        }),
      setIncognitoMode: (incognitoMode) => set({ incognitoMode }),
      setDefaultChapterSort: (defaultChapterSort) =>
        set({ defaultChapterSort }),
      setCheckIntervalHours: (hours) =>
        set({ checkIntervalHours: normalizeCheckIntervalHours(hours) }),
      setSkipCompletedChecks: (skipCompletedChecks) => set({ skipCompletedChecks }),
    }),
    {
      name: "norea-library-settings",
      merge: (persisted, current) => {
        const partial = (persisted && typeof persisted === "object"
          ? persisted
          : {}) as Partial<LibraryState>;
        return {
          ...current,
          ...partial,
          selectedStatuses: sanitizeStatusList(partial.selectedStatuses),
          selectedTags: sanitizeTagList(partial.selectedTags),
        };
      },
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
        selectedStatuses: state.selectedStatuses,
        selectedTags: state.selectedTags,
        defaultCategoryId: state.defaultCategoryId,
        incognitoMode: state.incognitoMode,
        defaultChapterSort: state.defaultChapterSort,
        checkIntervalHours: state.checkIntervalHours,
        skipCompletedChecks: state.skipCompletedChecks,
      }),
    },
  ),
);
