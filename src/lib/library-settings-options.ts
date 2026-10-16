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
  compact: "librarySettings.display.compact",
  comfortable: "librarySettings.display.comfortable",
  "cover-only": "librarySettings.display.coverOnly",
  list: "librarySettings.display.list",
};

export const LIBRARY_DISPLAY_MODES: LibraryDisplayMode[] = [
  "compact",
  "comfortable",
  "cover-only",
  "list",
];

export const LIBRARY_SORT_ORDER_LABEL_KEYS: Record<
  LibrarySortOrder,
  TranslationKey
> = {
  nameAsc: "librarySettings.sort.nameAsc",
  nameDesc: "librarySettings.sort.nameDesc",
  downloadedAsc: "librarySettings.sort.downloadedAsc",
  downloadedDesc: "librarySettings.sort.downloadedDesc",
  undownloadedAsc: "librarySettings.sort.undownloadedAsc",
  undownloadedDesc: "librarySettings.sort.undownloadedDesc",
  totalChaptersAsc: "librarySettings.sort.totalChaptersAsc",
  totalChaptersDesc: "librarySettings.sort.totalChaptersDesc",
  unreadChaptersAsc: "librarySettings.sort.unreadChaptersAsc",
  unreadChaptersDesc: "librarySettings.sort.unreadChaptersDesc",
  dateAddedAsc: "librarySettings.sort.dateAddedAsc",
  dateAddedDesc: "librarySettings.sort.dateAddedDesc",
  lastReadAsc: "librarySettings.sort.lastReadAsc",
  lastReadDesc: "librarySettings.sort.lastReadDesc",
  lastUpdatedAsc: "librarySettings.sort.lastUpdatedAsc",
  lastUpdatedDesc: "librarySettings.sort.lastUpdatedDesc",
};

export const LIBRARY_SORT_ORDERS: LibrarySortOrder[] = [
  "nameAsc",
  "nameDesc",
  "downloadedAsc",
  "downloadedDesc",
  "undownloadedAsc",
  "undownloadedDesc",
  "totalChaptersAsc",
  "totalChaptersDesc",
  "unreadChaptersAsc",
  "unreadChaptersDesc",
  "dateAddedAsc",
  "dateAddedDesc",
  "lastReadAsc",
  "lastReadDesc",
  "lastUpdatedAsc",
  "lastUpdatedDesc",
];

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
