import {
  isChapterMediaIncompleteError,
  isTransientMediaHttpStatus,
  isTransientMediaNetworkError,
} from "../chapter-media/errors";
import type { ChapterMediaFailure } from "../chapter-media/types";
import type { CHAPTER_DOWNLOAD_FAILURE_CLASSES } from "../../db/schema";
import { describeError } from "../errors";
import { errorHttpStatus, isHttpNotFoundError } from "../http/status-error";
import { isNetworkUnavailableError } from "../network";
import { isPluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { normalizeSourceAccessRequiredError } from "../plugins/source-access";
import { redactUrlsForLog } from "../url-log";

/** Consecutive single-chapter failures allowed before pausing a source queue. */
export const CONSECUTIVE_SOURCE_DOWNLOAD_FAILURE_LIMIT = 3;

export type DownloadFailureClass = (typeof CHAPTER_DOWNLOAD_FAILURE_CLASSES)[number];

export interface DownloadFailure {
  failureClass: DownloadFailureClass;
  /** The redacted, shortened error message shown to the user. */
  summary: string;
  /** The wait the server asked for through Retry-After, in milliseconds. */
  retryAfterMs: number;
  /** The challenged page, so verification opens the host that asked for it. */
  challengeUrl?: string;
}

const MAX_RETRY_AFTER_MS = 3_600_000;
const MAX_SUMMARY_LENGTH = 300;

const EXTERNAL_CHALLENGE =
  /External resource at (\S+?) requires Cloudflare verification/i;
const STORAGE_IO_FAILURE =
  /\b(?:no space left on device|disk (?:i\/o error|is full)|input\/output error|permission denied|database or disk is full|database disk image is malformed|SQLITE_(?:FULL|IOERR|CORRUPT|READONLY|CANTOPEN)|read-only file system|os error (?:5|13|28|30)|storage (?:root|folder) (?:is )?(?:unavailable|not available))\b/i;
const STORAGE_FAILURE =
  /^Chapter storage failed\b|\b(?:no space left on device|disk (?:i\/o error|is full)|database or disk is full|database disk image is malformed|SQLITE_(?:FULL|IOERR|CORRUPT|READONLY|CANTOPEN)|read-only file system|os error (?:28|30)|storage (?:root|folder) (?:is )?(?:unavailable|not available))\b/i;
const CHAPTER_MEDIA_VERIFICATION_FAILURE =
  /chapter media: (?:media archive finalization incomplete:|media manifest is missing\b|a valid manifest is required for repair\b)|Cannot read chapter media manifest\.|Chapter media manifest is (?:invalid|missing asset:)|Cannot repair media asset without a source URL:/i;
const CONTENT_FAILURE =
  /^(?:chapter-download: local chapter \d+ was not found|chapter-media-repair: local chapter \d+ was not found|Chapter acquisition |Plugin must declare a resource acquisition plan|content-not-found:)|This chapter is not on the content server, and its source has no matching chapter\.|Downloaded chapter metadata is missing\.|Server chapter novel ID does not match the local work\.|Content server (?:chapter|repair chapter) no longer exists locally\.|Content server (?:download|repair|media) identity does not match /i;
/** The source site now lives at another address; retrying the old one cannot succeed. */
const SOURCE_SITE_MOVED = /; the page moved to \S+, outside the source site /;
const MANUAL_ACTION_REQUIRED = /manual-action-required:/i;
const INCOMPLETE_MEDIA_SUMMARY = /^(?:HTTP 404: )?Offline download is incomplete:/i;
const PLUGIN_PARSE_ERROR_NAMES = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError"]);
const SERVER_CHAPTER_MISSING = "This chapter is not on the content server.";

/** A content-server work lacks this chapter's body; only an explicit retry may continue to the source. */
export class ServerChapterMissingError extends Error {
  readonly code = "content-server-chapter-missing";

  constructor() {
    super(SERVER_CHAPTER_MISSING);
    this.name = "ServerChapterMissingError";
  }
}

/** Recognizes the error, a task's error text, or a stored failure summary. */
export function isServerChapterMissingFailure(error: unknown): boolean {
  return describeError(error) === SERVER_CHAPTER_MISSING;
}

/** Recognizes an incomplete-media error, task error text, or stored failure summary. */
export function isIncompleteMediaFailure(error: unknown): boolean {
  return isChapterMediaIncompleteError(error) || INCOMPLETE_MEDIA_SUMMARY.test(describeError(error));
}

/** Single-chapter media manifest or archive verification mismatch, not a global storage outage. */
export function isChapterMediaVerificationFailure(error: unknown): boolean {
  const message = describeError(error);
  return CHAPTER_MEDIA_VERIFICATION_FAILURE.test(message) && !STORAGE_IO_FAILURE.test(message);
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
}

function summarize(error: unknown): string {
  const message = redactUrlsForLog(describeError(error)).replace(/\s+/g, " ").trim();
  return message.length > MAX_SUMMARY_LENGTH ? `${message.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : message;
}

function retryAfter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, value)) : 0;
}

function externalChallengeUrl(message: string): string | undefined {
  const host = EXTERNAL_CHALLENGE.exec(message)?.[1]?.replace(/[.,]+$/, "");
  if (!host) return undefined;
  try {
    return new URL(`https://${host}/`).href;
  } catch {
    return undefined;
  }
}

function isTransientMediaFailure(failure: ChapterMediaFailure): boolean {
  return failure.status !== undefined
    ? isTransientMediaHttpStatus(failure.status) || failure.status >= 500
    : isTransientMediaNetworkError(failure.message);
}

/** An HTTP 403 access refusal, including the source-access hold created for it. */
export function isSourceForbiddenFailure(error: unknown): boolean {
  if (errorCode(error) === "content-server-request-failed") return false;
  const access = normalizeSourceAccessRequiredError(error);
  return access ? access.challenge.kind === "forbidden" : errorHttpStatus(error) === 403;
}

/**
 * Whether an incomplete-media chapter failure only reflects unavailable per-asset
 * resources rather than a storage, source-access, forbidden, or rate-limit block.
 */
export function isSkippableIncompleteMediaFailure(error: unknown): boolean {
  if (!isChapterMediaIncompleteError(error)) return false;
  const failure = classifyDownloadFailure(error);
  if (failure.failureClass === "storage" || failure.failureClass === "challenge") {
    return false;
  }
  if (
    isSourceForbiddenFailure(error) ||
    error.failures.some((item) => errorHttpStatus(item) === 403)
  ) {
    return false;
  }
  if (error.failures.some((item) => errorHttpStatus(item) === 429)) {
    return false;
  }
  return true;
}

/**
 * Whether a failure indicates a source-wide or environment block that must pause
 * the source queue immediately instead of consuming the consecutive-failure budget.
 */
export function isImmediateSourceStopFailure(error: unknown): boolean {
  const failure = classifyDownloadFailure(error);
  if (failure.failureClass === "storage" || failure.failureClass === "challenge") {
    return true;
  }
  const status = errorHttpStatus(error);
  if (isSourceForbiddenFailure(error) || status === 401 || status === 403 || status === 429) {
    return true;
  }
  if (
    isChapterMediaIncompleteError(error) &&
    error.failures.some((item) => {
      const itemStatus = errorHttpStatus(item);
      return itemStatus === 403 || itemStatus === 429;
    })
  ) {
    return true;
  }
  const message = describeError(error);
  if (SOURCE_SITE_MOVED.test(message) || MANUAL_ACTION_REQUIRED.test(message)) {
    return true;
  }
  return isPluginVpnUnavailableError(error) || isNetworkUnavailableError(error);
}

/**
 * Groups errors for diagnostics. The recovery policy separately authorizes bounded attempts.
 */
export function classifyDownloadFailure(error: unknown): DownloadFailure {
  const summary = summarize(errorCode(error) === "chapter-media-incomplete" && isHttpNotFoundError(error)
    ? `HTTP 404: ${describeError(error)}` : error);
  const message = describeError(error);
  const failure = (failureClass: DownloadFailureClass, extra: Partial<DownloadFailure> = {}): DownloadFailure =>
    ({ failureClass, summary, retryAfterMs: 0, ...extra });

  if (
    (errorCode(error) === "chapter-storage-failed" || errorCode(error) === "chapter-media-finalization-failed") &&
    isChapterMediaVerificationFailure(error)
  ) {
    return failure("media-incomplete");
  }
  if (errorCode(error) === "chapter-storage-failed" || errorCode(error) === "chapter-media-finalization-failed") return failure("storage");
  if (isServerChapterMissingFailure(error)) return failure("content");
  if (errorCode(error) === "content-server-request-failed") {
    if ((error as { retryable?: unknown }).retryable === true) return failure("transient");
    const status = errorHttpStatus(error);
    return failure(status !== undefined && status < 500 && status !== 408 && status !== 429 ? "content" : "transient");
  }
  const sourceAccess = normalizeSourceAccessRequiredError(error);
  if (sourceAccess) return failure("challenge", { challengeUrl: sourceAccess.challenge.url });
  const externalChallenge = externalChallengeUrl(message);
  if (externalChallenge) return failure("challenge", { challengeUrl: externalChallenge });

  if (errorCode(error) === "chapter-media-incomplete") {
    const failures = ((error as { failures?: unknown }).failures ?? []) as readonly ChapterMediaFailure[];
    const challengeUrl = failures.map((item) => externalChallengeUrl(item.message)).find(Boolean);
    if (challengeUrl) return failure("challenge", { challengeUrl });
    const delay = retryAfter((error as { retryAfterMs?: unknown }).retryAfterMs);
    return failure(failures.length > 0 && failures.every(isTransientMediaFailure) ? "transient" : "media-incomplete",
      { retryAfterMs: delay });
  }
  if (errorCode(error) === "chapter-media-http-retry") {
    return failure("transient", { retryAfterMs: retryAfter((error as { retryAfterMs?: unknown }).retryAfterMs) });
  }
  if (isChapterMediaVerificationFailure(error)) return failure("media-incomplete");
  if (STORAGE_FAILURE.test(message)) return failure("storage");
  if (CONTENT_FAILURE.test(message) || SOURCE_SITE_MOVED.test(message)) return failure("content");
  const name = errorName(error);
  if (name && PLUGIN_PARSE_ERROR_NAMES.has(name)) return failure("content");
  const status = errorHttpStatus(error);
  if (status !== undefined && status < 500 && status !== 408 && status !== 429) {
    return failure("content");
  }
  return failure("transient", { retryAfterMs: retryAfter(error !== null && typeof error === "object" ? (error as { retryAfterMs?: unknown }).retryAfterMs : undefined) });
}

/** Download errors require an explicit retry, including formerly scheduled transient failures. */
export function automaticRetryDelayMs(
  _failure: Pick<DownloadFailure, "failureClass" | "retryAfterMs">,
  _attempts: number,
): null {
  return null;
}
