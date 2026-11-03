import type { TranslationKey } from "../i18n";
import type {
  DefaultChapterSort,
  LibraryDisplayMode,
  LibrarySortOrder,
} from "../store/library";

export const LIBRARY_DISPLAY_MODE_LABEL_KEYS: Record<
  LibraryDisplayMode,
  TranslationKey
> = {
  comfortable: "librarySettings.display.comfortable",
  compact: "librarySettings.display.compact",
  "cover-only": "librarySettings.display.coverOnly",
  list: "librarySettings.display.list",
};

export const LIBRARY_DISPLAY_MODES: LibraryDisplayMode[] = [
  "comfortable",
  "compact",
  "cover-only",
  "list",
];

export type LibrarySortField =
  | "name"
  | "downloaded"
  | "undownloaded"
  | "totalChapters"
  | "unreadChapters"
  | "dateAdded"
  | "lastRead"
  | "lastUpdated";

export type LibrarySortDirection = "asc" | "desc";

export const LIBRARY_SORT_FIELDS: LibrarySortField[] = [
  "name",
  "dateAdded",
  "lastRead",
  "lastUpdated",
  "unreadChapters",
  "totalChapters",
  "downloaded",
  "undownloaded",
];

export const LIBRARY_SORT_FIELD_LABEL_KEYS: Record<
  LibrarySortField,
  TranslationKey
> = {
  name: "librarySettings.sortField.name",
  downloaded: "librarySettings.sortField.downloaded",
  undownloaded: "librarySettings.sortField.undownloaded",
  totalChapters: "librarySettings.sortField.totalChapters",
  unreadChapters: "librarySettings.sortField.unreadChapters",
  dateAdded: "librarySettings.sortField.dateAdded",
  lastRead: "librarySettings.sortField.lastRead",
  lastUpdated: "librarySettings.sortField.lastUpdated",
};

export const LIBRARY_SORT_DIRECTION_LABEL_KEYS: Record<
  LibrarySortDirection,
  TranslationKey
> = {
  asc: "librarySettings.sortDirection.asc",
  desc: "librarySettings.sortDirection.desc",
};

export function getLibrarySortField(order: LibrarySortOrder): LibrarySortField {
  return order.replace(/(Asc|Desc)$/, "") as LibrarySortField;
}

export function getLibrarySortDirection(
  order: LibrarySortOrder,
): LibrarySortDirection {
  return order.endsWith("Asc") ? "asc" : "desc";
}

export function toLibrarySortOrder(
  field: LibrarySortField,
  direction: LibrarySortDirection,
): LibrarySortOrder {
  return `${field}${direction === "asc" ? "Asc" : "Desc"}`;
}

export const DEFAULT_CHAPTER_SORT_LABEL_KEYS: Record<
  DefaultChapterSort,
  TranslationKey
> = {
  asc: "librarySettings.oldestFirst",
  desc: "librarySettings.newestFirst",
};

export const DEFAULT_CHAPTER_SORT_ORDERS: DefaultChapterSort[] = [
  "asc",
  "desc",
];
