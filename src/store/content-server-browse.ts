import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ServerWorkFilter } from "../lib/content-sync/browse";
import { isNovelStatus, type NovelStatusValue } from "../lib/plugins/types";

interface ContentServerBrowseFilters extends ServerWorkFilter {
  categories: string[];
  draft: string;
  statuses: NovelStatusValue[];
  tags: string[];
}

export const EMPTY_CONTENT_SERVER_BROWSE_FILTERS: ContentServerBrowseFilters = {
  categories: [],
  draft: "",
  query: "",
  source: "",
  statuses: [],
  tags: [],
  uncategorized: false,
};

function sanitizeStatusList(raw: unknown): NovelStatusValue[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<NovelStatusValue>();
  for (const item of raw) {
    if (isNovelStatus(item) && !seen.has(item)) seen.add(item);
  }
  return [...seen];
}

function sanitizeCategoryList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    categories.push(cleaned);
  }
  return categories;
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

interface ContentServerBrowseState {
  filtersByServer: Record<string, ContentServerBrowseFilters>;
  setFilters: (server: string, filters: Partial<ServerWorkFilter & { draft: string }>) => void;
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
    categories: sanitizeCategoryList(value.categories),
    draft: typeof value.draft === "string" ? value.draft : "",
    query: typeof value.query === "string" ? value.query : "",
    source: typeof value.source === "string" ? value.source : "",
    statuses: sanitizeStatusList(value.statuses),
    tags: sanitizeTagList(value.tags),
    uncategorized: value.uncategorized === true,
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
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ filtersByServer: state.filtersByServer }),
      migrate: (persisted, version) => ({
        filtersByServer: version > 2 ? {} : readPersistedFilters(persisted),
      }),
      merge: (persisted, current) => ({
        ...current,
        filtersByServer: readPersistedFilters(persisted),
      }),
    },
  ),
);
