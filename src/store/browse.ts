import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GlobalSearchResult } from "../lib/plugins/global-search";
import { taskScheduler } from "../lib/tasks/scheduler";

export const DEFAULT_SOURCE_WORK_CONCURRENCY = 3;
export const DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS = 30;
export const DEFAULT_CHAPTER_DOWNLOAD_COOLDOWN_SECONDS = 1;

function normalizeStringArray(
  value: unknown,
  fallback: string[],
): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeConcurrency(
  value: unknown,
  fallback = DEFAULT_SOURCE_WORK_CONCURRENCY,
): number {
  const numeric = typeof value === "number" ? value : fallback;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(10, Math.round(numeric)));
}

function normalizeTimeoutSeconds(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS;
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS;
  }
  return Math.max(5, Math.min(120, Math.round(numeric)));
}

function normalizeChapterDownloadCooldownSeconds(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : DEFAULT_CHAPTER_DOWNLOAD_COOLDOWN_SECONDS;
  if (!Number.isFinite(numeric)) {
    return DEFAULT_CHAPTER_DOWNLOAD_COOLDOWN_SECONDS;
  }
  return Math.max(0, Math.min(60, Math.round(numeric)));
}

export type GlobalSearchSort = "pinned" | "name";

function normalizeGlobalSearchSort(value: unknown): GlobalSearchSort {
  return value === "name" ? "name" : "pinned";
}

interface BrowseGlobalSearchState {
  query: string;
  searchKey: string;
  results: GlobalSearchResult[];
  searching: boolean;
  totalPluginCount: number;
}

const EMPTY_GLOBAL_SEARCH: BrowseGlobalSearchState = {
  query: "",
  searchKey: "",
  results: [],
  searching: false,
  totalPluginCount: 0,
};

interface BrowseState {
  /**
   * URL pending insertion via the Add Repository modal, set by
   * a `norea://repo/add?url=...` deep-link or other intent.
   * The Browse route consumes and clears it on render.
   */
  pendingRepoUrl: string | null;
  pluginLanguageFilter: string[];
  sourceWorkConcurrency: number;
  sourceRequestTimeoutSeconds: number;
  chapterDownloadCooldownSeconds: number;
  pinnedPluginIds: string[];
  lastUsedPluginId: string | null;
  /** Order of global search result sections; the last choice is kept. */
  globalSearchSort: GlobalSearchSort;
  /** Install newer versions from each plugin's publisher without asking. */
  autoUpdateExtensions: boolean;
  globalSearch: BrowseGlobalSearchState;
  setPendingRepoUrl: (url: string | null) => void;
  clearPendingRepoUrl: () => void;
  setPluginLanguageFilter: (languages: string[]) => void;
  setSourceWorkConcurrency: (concurrency: number) => void;
  setSourceRequestTimeoutSeconds: (seconds: number) => void;
  setChapterDownloadCooldownSeconds: (seconds: number) => void;
  togglePinnedPlugin: (pluginId: string) => void;
  setLastUsedPluginId: (pluginId: string | null) => void;
  setGlobalSearchSort: (sort: GlobalSearchSort) => void;
  setAutoUpdateExtensions: (enabled: boolean) => void;
  beginGlobalSearch: (search: BrowseGlobalSearchState) => void;
  appendGlobalSearchResult: (
    searchKey: string,
    result: GlobalSearchResult,
  ) => void;
  finishGlobalSearch: (searchKey: string) => void;
  clearGlobalSearch: () => void;
}

export const useBrowseStore = create<BrowseState>()(
  persist(
    (set) => ({
      pendingRepoUrl: null,
      pluginLanguageFilter: [],
      sourceWorkConcurrency: DEFAULT_SOURCE_WORK_CONCURRENCY,
      sourceRequestTimeoutSeconds: DEFAULT_SOURCE_REQUEST_TIMEOUT_SECONDS,
      chapterDownloadCooldownSeconds:
        DEFAULT_CHAPTER_DOWNLOAD_COOLDOWN_SECONDS,
      pinnedPluginIds: [],
      lastUsedPluginId: null,
      globalSearchSort: "pinned",
      autoUpdateExtensions: false,
      globalSearch: EMPTY_GLOBAL_SEARCH,
      setPendingRepoUrl: (pendingRepoUrl) => set({ pendingRepoUrl }),
      clearPendingRepoUrl: () => set({ pendingRepoUrl: null }),
      setPluginLanguageFilter: (pluginLanguageFilter) =>
        set({
          pluginLanguageFilter: normalizeStringArray(
            pluginLanguageFilter,
            [],
          ),
        }),
      setSourceWorkConcurrency: (sourceWorkConcurrency) => {
        const concurrency = normalizeConcurrency(sourceWorkConcurrency);
        taskScheduler.setSourceForegroundConcurrency(concurrency);
        set({
          sourceWorkConcurrency: concurrency,
        });
      },
      setSourceRequestTimeoutSeconds: (sourceRequestTimeoutSeconds) =>
        set({
          sourceRequestTimeoutSeconds: normalizeTimeoutSeconds(
            sourceRequestTimeoutSeconds,
          ),
        }),
      setChapterDownloadCooldownSeconds: (chapterDownloadCooldownSeconds) =>
        set({
          chapterDownloadCooldownSeconds:
            normalizeChapterDownloadCooldownSeconds(
              chapterDownloadCooldownSeconds,
            ),
        }),
      togglePinnedPlugin: (pluginId) =>
        set((state) => ({
          pinnedPluginIds: state.pinnedPluginIds.includes(pluginId)
            ? state.pinnedPluginIds.filter((id) => id !== pluginId)
            : [...state.pinnedPluginIds, pluginId],
        })),
      setLastUsedPluginId: (lastUsedPluginId) => set({ lastUsedPluginId }),
      setGlobalSearchSort: (globalSearchSort) =>
        set({ globalSearchSort: normalizeGlobalSearchSort(globalSearchSort) }),
      setAutoUpdateExtensions: (autoUpdateExtensions) => set({ autoUpdateExtensions }),
      beginGlobalSearch: (globalSearch) => set({ globalSearch }),
      appendGlobalSearchResult: (searchKey, result) =>
        set((state) => {
          if (state.globalSearch.searchKey !== searchKey) return state;
          const results = state.globalSearch.results.filter(
            (row) => row.pluginId !== result.pluginId,
          );
          return {
            globalSearch: {
              ...state.globalSearch,
              results: [...results, result],
            },
          };
        }),
      finishGlobalSearch: (searchKey) =>
        set((state) =>
          state.globalSearch.searchKey === searchKey
            ? {
                globalSearch: {
                  ...state.globalSearch,
                  searching: false,
                },
              }
            : state,
        ),
      clearGlobalSearch: () => set({ globalSearch: EMPTY_GLOBAL_SEARCH }),
    }),
    {
      name: "browse-plugin-settings",
      merge: (persistedState, currentState) => {
        if (persistedState === null || typeof persistedState !== "object") {
          return currentState;
        }
        const persisted = persistedState as Partial<BrowseState>;
        const sourceWorkConcurrency = normalizeConcurrency(
          persisted.sourceWorkConcurrency,
        );
        taskScheduler.setSourceForegroundConcurrency(sourceWorkConcurrency);
        return {
          ...currentState,
          pluginLanguageFilter: normalizeStringArray(
            persisted.pluginLanguageFilter,
            currentState.pluginLanguageFilter,
          ),
          sourceWorkConcurrency,
          sourceRequestTimeoutSeconds: normalizeTimeoutSeconds(
            persisted.sourceRequestTimeoutSeconds,
          ),
          chapterDownloadCooldownSeconds:
            normalizeChapterDownloadCooldownSeconds(
              persisted.chapterDownloadCooldownSeconds,
            ),
          pinnedPluginIds: normalizeStringArray(
            persisted.pinnedPluginIds,
            currentState.pinnedPluginIds,
          ),
          lastUsedPluginId:
            typeof persisted.lastUsedPluginId === "string"
              ? persisted.lastUsedPluginId
              : null,
          globalSearchSort: normalizeGlobalSearchSort(persisted.globalSearchSort),
          autoUpdateExtensions: persisted.autoUpdateExtensions === true,
        };
      },
      partialize: (state) => ({
        pluginLanguageFilter: normalizeStringArray(
          state.pluginLanguageFilter,
          [],
        ),
        sourceWorkConcurrency: normalizeConcurrency(
          state.sourceWorkConcurrency,
        ),
        sourceRequestTimeoutSeconds: normalizeTimeoutSeconds(
          state.sourceRequestTimeoutSeconds,
        ),
        chapterDownloadCooldownSeconds:
          normalizeChapterDownloadCooldownSeconds(
            state.chapterDownloadCooldownSeconds,
          ),
        pinnedPluginIds: normalizeStringArray(state.pinnedPluginIds, []),
        lastUsedPluginId: state.lastUsedPluginId,
        globalSearchSort: normalizeGlobalSearchSort(state.globalSearchSort),
        autoUpdateExtensions: state.autoUpdateExtensions,
      }),
    },
  ),
);

export function getSourceRequestTimeoutSeconds(): number {
  return normalizeTimeoutSeconds(
    useBrowseStore.getState().sourceRequestTimeoutSeconds,
  );
}

export function getSourceRequestTimeoutMs(): number {
  return getSourceRequestTimeoutSeconds() * 1000;
}
