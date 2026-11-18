import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  isKnownChapterContentType,
  type ChapterContentType,
} from "../chapter-content";
import { isStorageId } from "../storage-id";
import { isRecord } from "../type-guards";
import {
  isNovelStatus,
  type ChapterItem,
  type NovelItem,
  type SourceNovel,
} from "./types";

const OPTIONAL_NOVEL_STRING_FIELDS = [
  "artist",
  "author",
  "cover",
  "genres",
  "summary",
] as const;

const URL_SCHEME_PREFIX_RE = /^(?:https?:)?\/\//i;

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function assertPluginChapterContentType(
  value: unknown,
  createError: (message: string) => Error = (message) => new Error(message),
): ChapterContentType {
  if (value === undefined) return DEFAULT_CHAPTER_CONTENT_TYPE;
  if (!isKnownChapterContentType(value)) {
    throw createError(`unsupported chapter contentType "${String(value)}".`);
  }
  return value;
}

export function assertNovelItems(
  pluginId: string,
  method: "popularNovels" | "searchNovels",
  value: unknown,
): NovelItem[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Plugin '${pluginId}' ${method} did not return a novel list.`,
    );
  }
  for (const [index, entry] of value.entries()) {
    if (
      !isRecord(entry) ||
      !hasNonEmptyString(entry.name) ||
      !hasNonEmptyString(entry.path)
    ) {
      throw new Error(
        `Plugin '${pluginId}' ${method} returned item ${index + 1} without a valid name or path.`,
      );
    }
    if (URL_SCHEME_PREFIX_RE.test(entry.path)) {
      throw new Error(
        `Plugin '${pluginId}' ${method} item ${index + 1} path must exclude the base URL.`,
      );
    }
    if (entry.cover !== undefined && typeof entry.cover !== "string") {
      throw new Error(
        `Plugin '${pluginId}' ${method} item ${index + 1} has a non-string cover.`,
      );
    }
  }
  return value as NovelItem[];
}

export interface SourceNovelValidationMessages {
  invalidStatus?: (label: string, status: unknown) => string;
}

export interface SourceChapterValidationMessages {
  invalidChapterNumber?: (label: string, index: number) => string;
  invalidContentType?: (label: string, index: number, value: unknown) => string;
}

export function assertValidSourceNovelMetadata(
  value: unknown,
  label: string,
  createError: (message: string) => Error = (message) => new Error(message),
  messages?: SourceNovelValidationMessages,
): asserts value is SourceNovel {
  if (
    !isRecord(value) ||
    !hasNonEmptyString(value.name) ||
    !hasNonEmptyString(value.path)
  ) {
    throw createError(`${label} is missing its novel name or path.`);
  }
  if (URL_SCHEME_PREFIX_RE.test(value.path)) {
    throw createError(`${label} novel path must exclude the base URL.`);
  }
  if (!isStorageId(value.novelId)) {
    throw createError(`${label} returned an invalid novel ID.`);
  }
  if (!isNovelStatus(value.status)) {
    throw createError(
      messages?.invalidStatus
        ? messages.invalidStatus(label, value.status)
        : `${label} returned an invalid novel status '${String(value.status)}'.`,
    );
  }
  for (const field of OPTIONAL_NOVEL_STRING_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw createError(`${label} field '${field}' must be a string.`);
    }
  }
  if (
    value.rating !== undefined &&
    (typeof value.rating !== "number" ||
      !Number.isFinite(value.rating) ||
      value.rating < 0 ||
      value.rating > 5)
  ) {
    throw createError(`${label} returned a rating outside 0 to 5.`);
  }
  if (
    value.totalPages !== undefined &&
    (typeof value.totalPages !== "number" ||
      !Number.isFinite(value.totalPages) ||
      value.totalPages < 0)
  ) {
    throw createError(`${label} field 'totalPages' must be finite.`);
  }
  if (!Array.isArray(value.chapters)) {
    throw createError(`${label} did not return a chapter list.`);
  }
}

export function assertValidSourceChapterItem(
  chapter: unknown,
  index: number,
  label: string,
  createError: (message: string) => Error = (message) => new Error(message),
  messages?: SourceChapterValidationMessages,
): asserts chapter is ChapterItem {
  if (
    !isRecord(chapter) ||
    !hasNonEmptyString(chapter.name) ||
    !hasNonEmptyString(chapter.path)
  ) {
    throw createError(`${label} chapter ${index + 1} has no name or path.`);
  }
  const chapterNumber = chapter.chapterNumber;
  if (
    typeof chapterNumber !== "number" ||
    !Number.isFinite(chapterNumber) ||
    !/^\d+(?:\.\d+)?$/.test(String(chapterNumber))
  ) {
    throw createError(
      messages?.invalidChapterNumber
        ? messages.invalidChapterNumber(label, index)
        : `${label} returned a chapter without a finite numeric chapterNumber.`,
    );
  }
  assertPluginChapterContentType(chapter.contentType, (message) =>
    createError(
      messages?.invalidContentType
        ? messages.invalidContentType(label, index, chapter.contentType)
        : `${label} chapter ${index + 1} has ${message}`,
    ),
  );
  if (
    chapter.sourceChapterId !== undefined &&
    (typeof chapter.sourceChapterId !== "string" ||
      chapter.sourceChapterId.trim() === "")
  ) {
    throw createError(`${label} returned an invalid sourceChapterId.`);
  }
  if (
    (chapter.page !== undefined && typeof chapter.page !== "string") ||
    (chapter.releaseTime !== undefined &&
      chapter.releaseTime !== null &&
      typeof chapter.releaseTime !== "string")
  ) {
    throw createError(
      `${label} chapter ${index + 1} has invalid optional metadata.`,
    );
  }
}
