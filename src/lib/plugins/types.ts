/** Plugin contract types shared by the 0.2 host runtime. */

import type { Filters, FilterToValues } from "./filterTypes";
import type { PluginInputSchema } from "./inputs";
import type { ChapterContentType } from "../chapter-content";

export const CURRENT_PLUGIN_API_VERSION = "0.2" as const;

export type PluginApiVersion = typeof CURRENT_PLUGIN_API_VERSION;

export const ChapterCaptureLoadStrategies = {
  Selector: "selector",
  NetworkIdle: "network-idle",
  ScrollToEnd: "scroll-to-end",
} as const;

export type ChapterCaptureLoadStrategy =
  (typeof ChapterCaptureLoadStrategies)[keyof typeof ChapterCaptureLoadStrategies];

export const ChapterCaptureErrorCodes = {
  InvalidPlan: "invalid-plan",
  NavigationFailed: "navigation-failed",
  ManualActionRequired: "manual-action-required",
  InteractionFailed: "interaction-failed",
  Timeout: "timeout",
  ContentNotFound: "content-not-found",
  ContentRejected: "content-rejected",
  CaptureFailed: "capture-failed",
  Cancelled: "cancelled",
} as const;

export type ChapterCaptureErrorCode =
  (typeof ChapterCaptureErrorCodes)[keyof typeof ChapterCaptureErrorCodes];

export const WebViewInteractionTypes = {
  Click: "click",
  Type: "type",
  Select: "select",
  WaitFor: "waitFor",
} as const;

export type WebViewInteractionType =
  (typeof WebViewInteractionTypes)[keyof typeof WebViewInteractionTypes];

interface WebViewInteractionBase {
  /** First matching element is the interaction target. */
  selector: string;
  /** Skips the step instead of failing when the target never appears. */
  optional?: boolean;
  /** Host-clamped wait for the target to appear. Defaults to 10 seconds. */
  timeoutMs?: number;
}

/**
 * One user-like DOM action the host performs inside the rendered source page
 * before it captures content. Steps run in order after the document is ready.
 */
export type WebViewInteraction =
  | ({ type: "click" } & WebViewInteractionBase)
  | ({
      type: "type";
      text: string;
      /** Empties the field before typing. */
      clear?: boolean;
      /** Presses Enter and submits the owning form after typing. */
      submit?: boolean;
    } & WebViewInteractionBase)
  | ({ type: "select"; value: string } & WebViewInteractionBase)
  | ({ type: "waitFor" } & WebViewInteractionBase);

export const SourceAccessChallengeKinds = {
  Captcha: "captcha",
  Cloudflare: "cloudflare",
  Forbidden: "forbidden",
} as const;

export type SourceAccessChallengeKind =
  (typeof SourceAccessChallengeKinds)[keyof typeof SourceAccessChallengeKinds];

export const SourceAccessErrorCodes = {
  ManualActionRequired: "manual-action-required",
  SourceAccessRequired: "source-access-required",
} as const;

export type SourceAccessErrorCode =
  (typeof SourceAccessErrorCodes)[keyof typeof SourceAccessErrorCodes];

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
  /** Captured text containing any of these strings fails with content-rejected and stores nothing. */
  rejectContentText?: string[];
  /** Runs before source page scripts and may prepare a capturable DOM root. */
  documentStartScript?: string;
  /** Optional previous/next chapter anchors. The host clicks only an exact destination match. */
  chapterLinkSelector?: string;
  /** User-like DOM steps performed after the document is ready and before capture. */
  interactions?: WebViewInteraction[];
  /** Defaults to network-idle. */
  loadStrategy?: ChapterCaptureLoadStrategy;
  /** Adds a host-owned query value while preserving source query parameters. */
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
  Ongoing = "Ongoing",
  Completed = "Completed",
  Cancelled = "Cancelled",
  OnHiatus = "On Hiatus",
}

export type NovelStatusValue = `${NovelStatus}`;

const NOVEL_STATUS_VALUES: ReadonlySet<string> = new Set<string>(
  Object.values(NovelStatus),
);

export function isNovelStatus(value: unknown): value is NovelStatusValue {
  return typeof value === "string" && NOVEL_STATUS_VALUES.has(value);
}

/**
 * Coerces a persisted or filter status value to one of the four canonical
 * `NovelStatus` constants, mapping blank, retired, or legacy non-canonical
 * values to `NovelStatus.Ongoing`.
 */
export function normalizeNovelStatus(value: unknown): NovelStatusValue {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isNovelStatus(trimmed)) return trimmed;
  }
  return NovelStatus.Ongoing;
}

export interface NovelItem {
  /** Reserved by upstream; host assigns the local DB id. */
  id?: undefined;
  name: string;
  /** Plugin-provided source-relative path or opaque identifier, stored unchanged. */
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
  /** Optional source identity independent of display/order numbering. */
  sourceChapterId?: string;
  /** ISO-8601 preferred; UI does best-effort parse. */
  releaseTime?: string;
  /** Pagination cursor for `parsePage()`. */
  page?: string;
}

export interface SourceNovel extends NovelItem {
  /** Stable plugin-owned ID used verbatim as the work directory name. */
  novelId: string;
  /** Comma- or pipe-delimited genre string. UI splits/normalizes. */
  genres?: string;
  summary?: string;
  author?: string;
  artist?: string;
  status: NovelStatusValue;
  /** Source rating from 0 to 5. */
  rating?: number;
  chapters: ChapterItem[];
  totalPages?: number;
}

export interface SourcePage {
  chapters: ChapterItem[];
}

export const PluginInstallModes = {
  Single: "single",
  MultiSource: "multiSource",
} as const;

export const PLUGIN_INSTALL_MODES = ["single", "multiSource"] as const;

export type PluginInstallMode = (typeof PLUGIN_INSTALL_MODES)[number];

export function isPluginInstallMode(value: unknown): value is PluginInstallMode {
  return value === "single" || value === "multiSource";
}

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
  pluginSettings?: PluginInputSchema;
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
  /** Resolve a source path to an absolute URL; preserve already absolute URLs. */
  resolveUrl?: (path: string, isNovel?: boolean) => string;
}

/** Reserved plugin id for novels imported from local files. */
export const LOCAL_PLUGIN_ID = "local" as const;
