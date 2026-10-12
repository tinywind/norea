import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  isHtmlLikeChapterContentType,
  normalizeChapterContentType,
  type ChapterContentType,
} from "./chapter-content";

const MEDIA_ELEMENT_PATTERN =
  /<(?:img|picture|source|video|audio|track|iframe|embed|object)\b[^>]*>/gi;
const REMOTE_URL_TOKEN_PATTERN = /(?:^|[\s"'(,=])(?:https?:)?\/\//i;
const REMOTE_STYLE_MEDIA_PATTERN =
  /\burl\(\s*["']?(?:https?:)?\/\//i;
const LOCAL_MEDIA_URL_PATTERN = /(?:^|[\s"'(,=])norea-media:\/\/reader-asset\//i;

function hasUnavailableMediaElement(content: string, mediaBytes?: number): boolean {
  MEDIA_ELEMENT_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(MEDIA_ELEMENT_PATTERN)) {
    if (REMOTE_URL_TOKEN_PATTERN.test(match[0]) || (mediaBytes === 0 && LOCAL_MEDIA_URL_PATTERN.test(match[0]))) return true;
  }
  return false;
}

export function chapterMediaRepairNeeded(
  content: string | null | undefined,
  contentType: ChapterContentType | string | null | undefined = DEFAULT_CHAPTER_CONTENT_TYPE,
  mediaBytes?: number,
): boolean {
  if (!isHtmlLikeChapterContentType(normalizeChapterContentType(contentType))) {
    return false;
  }
  if (!content) return false;
  return (
    hasUnavailableMediaElement(content, mediaBytes) ||
    REMOTE_STYLE_MEDIA_PATTERN.test(content) ||
    (mediaBytes === 0 && /\burl\(\s*["']?norea-media:\/\/reader-asset\//i.test(content))
  );
}

export function chapterMediaRepairFlag(
  content: string | null | undefined,
  contentType?: ChapterContentType | string | null,
): 0 | 1 {
  return chapterMediaRepairNeeded(content, contentType) ? 1 : 0;
}
