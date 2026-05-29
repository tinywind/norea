/**
 * Plugin contract types. These surface the upstream lnreader plugin
 * shape so most existing community plugins keep working in the
 * Tauri runtime. Where a field is awkward to type strictly we use
 * `unknown` and tighten later as call sites materialize.
 */

import type { Filters, FilterToValues } from "./filterTypes";
import type { PluginInputSchema } from "./inputs";
import type { ChapterContentType } from "../chapter-content";

export type ChapterBinaryMediaType = "application/pdf" | "application/epub+zip";

export interface ChapterBinaryResource {
  type: "binary";
  contentType: "pdf" | "epub";
  mediaType: ChapterBinaryMediaType;
  bytes: ArrayBuffer | Uint8Array;
  byteLength?: number;
}

export enum NovelStatus {
  Unknown = "Unknown",
  Ongoing = "Ongoing",
  Completed = "Completed",
  Licensed = "Licensed",
  PublishingFinished = "Publishing Finished",
  Cancelled = "Cancelled",
  OnHiatus = "On Hiatus",
}

export interface NovelItem {
  /** Reserved by upstream; host assigns the local DB id. */
  id?: undefined;
  name: string;
  /** Plugin-specific identifier (URL path or opaque string). */
  path: string;
  cover?: string;
}

export interface ChapterItem {
  name: string;
  path: string;
  /** Defaults to HTML for legacy plugins. */
  contentType?: ChapterContentType;
  /** Stable source-owned chapter order key, unique within one novel. */
  chapterNumber: number;
  /** ISO-8601 preferred; UI does best-effort parse. */
  releaseTime?: string;
  /** Pagination cursor for `parsePage()`. */
  page?: string;
}

export interface SourceNovel extends NovelItem {
  /** Comma- or pipe-delimited genre string. UI splits/normalizes. */
  genres?: string;
  summary?: string;
  author?: string;
  artist?: string;
  status?: NovelStatus;
  chapters: ChapterItem[];
  totalPages?: number;
}

export interface SourcePage {
  chapters: ChapterItem[];
}

export type PluginInstallMode = "single" | "multiSource";

export interface PluginItem {
  id: string;
  name: string;
  /** ISO 639 language code, e.g. "en", "ko", "zh". */
  lang: string;
  version: string;
  /** Raw source URL of `index.js` (used for updates). */
  url: string;
  iconUrl: string;
  customJS?: string;
  customCSS?: string;
  hasUpdate?: boolean;
  hasSettings?: boolean;
  installMode?: PluginInstallMode;
}

export interface PluginPopularOptions {
  showLatestNovels?: boolean;
  filters?: FilterToValues<Filters>;
}

export interface Plugin extends PluginItem {
  imageRequestInit?: {
    method?: string;
    /** Must include `User-Agent`; the host fills one in if missing. */
    headers: Record<string, string>;
    body?: string;
  };
  /** Filter schema rendered by the host as form controls. */
  filters?: Filters;
  /** App-managed input schema exposed to plugins through `@libs/pluginInputs`. */
  pluginInputs?: PluginInputSchema;
  /** Backward-compatible alias for upstream plugin setting declarations. */
  pluginSettings?: PluginInputSchema | Record<string, unknown>;
  /** Runtime base URL used by the host for source navigation and URL fallback. */
  getBaseUrl: () => string;
  popularNovels: (
    pageNo: number,
    options?: PluginPopularOptions,
  ) => Promise<NovelItem[]>;
  parseNovel: (novelPath: string) => Promise<SourceNovel>;
  parseNovelSince: (
    novelPath: string,
    sinceChapterNumber: number,
  ) => Promise<SourceNovel>;
  parsePage?: (novelPath: string, page: string) => Promise<SourcePage>;
  /**
   * Return content matching the chapter row's `contentType`.
   * Text-like bodies are converted to HTML before storage.
   */
  parseChapter: (chapterPath: string) => Promise<string>;
  /** Return first-class PDF/EPUB chapter resources. */
  parseChapterResource?: (chapterPath: string) => Promise<ChapterBinaryResource>;
  searchNovels: (
    searchTerm: string,
    pageNo: number,
  ) => Promise<NovelItem[]>;
  resolveUrl?: (path: string, isNovel?: boolean) => string;
  /** Run source tasks on the foreground scraper when per-page Web Storage is needed. */
  webStorageUtilized?: boolean;
}

/** Reserved plugin id for novels imported from local files. */
export const LOCAL_PLUGIN_ID = "local" as const;
