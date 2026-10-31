import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ContentServerBrowseFilters {
  draft: string;
  query: string;
  source: string;
}

export const EMPTY_CONTENT_SERVER_BROWSE_FILTERS: ContentServerBrowseFilters = {
  draft: "",
  query: "",
  source: "",
};

interface ContentServerBrowseState {
  filtersByServer: Record<string, ContentServerBrowseFilters>;
  setFilters: (server: string, filters: Partial<ContentServerBrowseFilters>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeFilters(value: Record<string, unknown>): ContentServerBrowseFilters {
  return {
    draft: typeof value.draft === "string" ? value.draft : "",
    query: typeof value.query === "string" ? value.query : "",
    source: typeof value.source === "string" ? value.source : "",
  };
}

function readPersistedFilters(value: unknown): Record<string, ContentServerBrowseFilters> {
  if (!isRecord(value) || !isRecord(value.filtersByServer)) return {};
  return Object.fromEntries(
    Object.entries(value.filtersByServer)
      .filter(([server, filters]) => isServerUrl(server) && isRecord(filters))
      .map(([server, filters]) => [server, normalizeFilters(filters as Record<string, unknown>)]),
  );
}

export const useContentServerBrowseStore = create<ContentServerBrowseState>()(
  persist(
    set => ({
      filtersByServer: {},
      setFilters: (server, filters) => {
        if (!isServerUrl(server)) return;
        set(state => ({
          filtersByServer: {
            ...state.filtersByServer,
            [server]: normalizeFilters({
              ...(state.filtersByServer[server] ?? EMPTY_CONTENT_SERVER_BROWSE_FILTERS),
              ...filters,
            }),
          },
        }));
      },
    }),
    {
      name: "content-server-browse-filters",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ filtersByServer: state.filtersByServer }),
      migrate: (persisted, version) => ({
        filtersByServer: version > 1 ? {} : readPersistedFilters(persisted),
      }),
      merge: (persisted, current) => ({
        ...current,
        filtersByServer: readPersistedFilters(persisted),
      }),
    },
  ),
);
