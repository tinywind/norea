/** Plugin contract types shared by the 0.2 host runtime. */

import type { Filters, FilterToValues } from "./filterTypes";
import type { PluginInputSchema } from "./inputs";
import type { ChapterContentType } from "../chapter-content";

export const CURRENT_PLUGIN_API_VERSION = "0.2" as const;

export type PluginApiVersion = typeof CURRENT_PLUGIN_API_VERSION;

export type ChapterCaptureLoadStrategy =
  | "selector"
  | "network-idle"
  | "scroll-to-end";

export type ChapterCaptureErrorCode =
  | "invalid-plan"
  | "navigation-failed"
  | "manual-action-required"
  | "timeout"
  | "content-not-found"
  | "capture-failed"
  | "cancelled";

export type SourceAccessChallengeKind = "captcha" | "cloudflare";

export interface SourceAccessChallenge {
  kind: SourceAccessChallengeKind;
  /** Absolute HTTP(S) URL where the challenge was observed. */
  url: string;
}

export type ChapterCaptureFailureEnvelope =
  | {
      ok: false;
      code: "manual-action-required";
      error: string;
      challenge?: SourceAccessChallenge;
    }
  | {
      ok: false;
      code: Exclude<ChapterCaptureErrorCode, "manual-action-required">;
      error: string;
      challenge?: never;
    };

export type TextChapterContentType = Extract<
  ChapterContentType,
  "html" | "text" | "markdown"
>;

/**
 * Declarative chapter navigation and capture instructions for the 0.2 API.
 * The host owns the WebView session, page archive, assets, and persistence.
 */
export interface ChapterPageAcquisitionPlan {
  type: "page";
  /** Absolute HTTP(S) URL. Required query parameters must be preserved. */
  url: string;
  /** First matching element becomes the reader content root. */
  contentSelector: string;
  /** Defaults to contentSelector. */
  readySelector?: string;
  /** Elements removed from the cloned content before it is stored. */
  excludeSelectors?: string[];
  /** Runs before source page scripts and may prepare a capturable DOM root. */
  documentStartScript?: string;
  /** Defaults to network-idle. */
  loadStrategy?: ChapterCaptureLoadStrategy;
  /** Adds a host-owned query value without discarding existing parameters. */
  cacheBust?: boolean;
  /** Host-clamped total navigation and capture timeout. */
  timeoutMs?: number;
}

export interface ChapterResourceAcquisitionPlan {
  type: "resource";
}

export type ChapterAcquisitionPlan =
  | ChapterPageAcquisitionPlan
  | ChapterResourceAcquisitionPlan;

export type ChapterBinaryMediaType = "application/pdf" | "application/epub+zip";

export interface ChapterBinaryResource {
  type: "binary";
  contentType: "pdf" | "epub";
  mediaType: ChapterBinaryMediaType;
  bytes: ArrayBuffer | Uint8Array;
  filename?: string;
  byteLength?: number;
}

export interface ChapterContentResource {
  type: "content";
  contentType: TextChapterContentType;
  content: string;
  /** Absolute URL used to resolve relative media references. */
  baseUrl?: string;
}

export type ChapterResource = ChapterContentResource | ChapterBinaryResource;

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
  /** Defaults to HTML. */
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
  /** Host/plugin contract version. */
  apiVersion: PluginApiVersion;
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
  /** Alias accepted for plugin setting declarations. */
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
  /** Return declarative browser capture or explicit resource acquisition. */
  getChapterAcquisitionPlan: (
    chapterPath: string,
    contentType: ChapterContentType,
  ) => ChapterAcquisitionPlan;
  /** Fetch non-page API, archive, PDF, or EPUB resources declared by the plan. */
  getChapterResource?: (
    chapterPath: string,
    contentType: ChapterContentType,
  ) => Promise<ChapterResource>;
  searchNovels: (
    searchTerm: string,
    pageNo: number,
  ) => Promise<NovelItem[]>;
  resolveUrl?: (path: string, isNovel?: boolean) => string;
}

/** Reserved plugin id for novels imported from local files. */
export const LOCAL_PLUGIN_ID = "local" as const;
