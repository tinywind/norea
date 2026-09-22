export {
  cacheHtmlChapterMedia,
  storeEmbeddedChapterMedia,
} from "./chapter-media/cache";
export {
  ChapterMediaFinalizationError,
  isChapterMediaFinalizationError,
} from "./chapter-media/errors";
export {
  collectChapterMediaElementPatches,
  hasRemoteChapterMedia,
  localChapterMediaSources,
  protectRemoteChapterMediaForPartialHtml,
  restoreProtectedRemoteChapterMediaSources,
} from "./chapter-media/html";
export {
  resolveLocalChapterMedia,
  resolveLocalChapterMediaPatches,
} from "./chapter-media/reader";
export {
  clearAllChapterMedia,
  clearChapterMedia,
  getStoredChapterMediaBytes,
  pruneChapterMedia,
  resolveLocalChapterMediaSrc,
} from "./chapter-media/storage";
export {
  type CacheChapterMediaResult,
  type ChapterMediaElementPatch,
  type ChapterMediaFailure,
  type ChapterMediaFinalizationErrorShape,
  type ChapterMediaStorageContext,
  type EmbeddedChapterMediaResource,
} from "./chapter-media/types";
