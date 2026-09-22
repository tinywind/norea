import { type HttpInit } from "../http";
import { type ScraperExecutorId } from "../tasks/scraper-queue";
import { type MediaSrcAttribute } from "./html";

type ChapterMediaRequestInit = Pick<HttpInit, "body" | "headers" | "method">;

export interface CacheChapterMediaOptions {
  baseUrl?: string | null;
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  contextUrl?: string;
  html: string;
  novelId?: number;
  novelName?: string | null;
  novelPath?: string | null;
  onHtmlUpdate?: (html: string) => Promise<void> | void;
  onMediaPatch?: (patches: ChapterMediaElementPatch[]) => Promise<void> | void;
  onProgress?: (progress: { current: number; total: number }) => void;
  previousHtml?: string | null;
  requestInit?: ChapterMediaRequestInit;
  repair?: boolean;
  scraperExecutor?: ScraperExecutorId;
  shouldYield?: () => boolean;
  signal?: AbortSignal;
  sourceId?: string;
  sourceAccessUrl?: string;
}

export interface ChapterMediaElementPatch {
  attributes: Record<string, string>;
  index: number;
  sourceAttributes?: Record<string, string>;
}

export interface ChapterMediaFailure {
  message: string;
  status?: number;
  url: string;
}

export interface ChapterMediaFinalizationErrorShape extends Error {
  readonly cause: unknown;
  readonly code: "chapter-media-finalization-failed";
}

export interface CacheChapterMediaResult {
  html: string;
  mediaFailures: ChapterMediaFailure[];
  mediaBytes: number;
  storedMediaCount: number;
}

export interface EmbeddedChapterMediaResource {
  bytes: Uint8Array | readonly number[];
  contentType?: string | null;
  fileName: string;
  placeholder: string;
  sourcePath?: string;
}

export interface ChapterMediaStoreInput {
  body: Uint8Array | readonly number[];
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  contentType?: string | null;
  fileName: string;
  novelId?: number;
  novelName?: string | null;
  novelPath?: string | null;
  sourceId?: string;
}

export interface ChapterMediaArchiveInput {
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  novelId?: number;
  novelName?: string | null;
  novelPath?: string | null;
  sourceId?: string;
}

export interface ChapterMediaStorageContext {
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  novelId?: number | null;
  novelName?: string | null;
  novelPath?: string | null;
  sourceId?: string | null;
}

export interface ChapterMediaManifestFile {
  bytes: number;
  contentType?: string;
  fileName: string;
  path: string;
  sourceUrl: string;
  status: "remote" | "stored";
  updatedAt: number;
}

export interface ChapterMediaManifest {
  complete: boolean;
  media: {
    files: ChapterMediaManifestFile[];
  };
  updatedAt: number;
  version: 1;
}

export interface MediaSrcTarget {
  attribute: MediaSrcAttribute;
  element: Element;
  slotIndex: number;
  url: string;
}

export interface MediaStyleUrl {
  source: string;
  url: string;
}

export interface MediaStyleTarget {
  element: Element;
  slotIndex: number;
  style: string;
  urls: MediaStyleUrl[];
}

export interface SrcsetCandidate {
  descriptor: string;
  source: string;
}

export interface MediaSrcsetTarget {
  candidates: SrcsetCandidate[];
  element: Element;
  slotIndex: number;
}

export interface ExistingMediaSlots {
  srcSlots: Array<string | null>;
  srcsetSlots: Array<Array<string | null>>;
  styleSlots: Array<Array<string | null>>;
}
