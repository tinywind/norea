import {
  isTransientMediaHttpStatus,
  isTransientMediaNetworkError,
} from "../chapter-media/errors";
import type { ChapterMediaFailure } from "../chapter-media/types";
import { describeError } from "../errors";
import { normalizeSourceAccessRequiredError } from "../plugins/source-access";
import { redactUrlsForLog } from "../url-log";

export const DOWNLOAD_FAILURE_CLASSES = [
  "transient",
  "challenge",
  "content",
  "storage",
  "media-incomplete",
] as const;

export type DownloadFailureClass = (typeof DOWNLOAD_FAILURE_CLASSES)[number];

export interface DownloadFailure {
  failureClass: DownloadFailureClass;
  /** The redacted, shortened error message shown to the user. */
  summary: string;
  /** The wait the server asked for through Retry-After, in milliseconds. */
  retryAfterMs: number;
  /** The challenged page, so verification opens the host that asked for it. */
  challengeUrl?: string;
}

/** Waits before the first, second and third automatic attempt after a transient failure. */
export const AUTOMATIC_RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;

const MAX_RETRY_AFTER_MS = 3_600_000;
const MAX_SUMMARY_LENGTH = 300;

const EXTERNAL_CHALLENGE =
  /External resource at (\S+?) requires Cloudflare verification/i;
const STORAGE_FAILURE =
  /\b(?:no space left on device|disk (?:i\/o error|is full)|database or disk is full|database disk image is malformed|SQLITE_(?:FULL|IOERR|CORRUPT|READONLY|CANTOPEN)|read-only file system|os error (?:28|30)|storage (?:root|folder) (?:is )?(?:unavailable|not available))\b/i;
const CONTENT_FAILURE =
  /^(?:chapter-download: local chapter \d+ was not found|Chapter acquisition |Plugin must declare a resource acquisition plan|content-not-found:)|This chapter is not on the content server, and its source has no matching chapter\./i;
const PLUGIN_PARSE_ERROR_NAMES = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError"]);
const HTTP_STATUS = /\b(?:HTTP|status(?: code)?)\s*:?\s*(\d{3})\b|\((\d{3})\)/i;

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

function httpStatus(message: string): number | undefined {
  const match = HTTP_STATUS.exec(message);
  const status = Number(match?.[1] ?? match?.[2]);
  return status >= 400 && status <= 599 ? status : undefined;
}

/**
 * Sorts a terminal chapter download error into the class that decides whether the
 * app retries it by itself. Unknown errors count as transient because the retry
 * budget is bounded and a wrong "content" verdict would need the user's tap.
 */
export function classifyDownloadFailure(error: unknown): DownloadFailure {
  const summary = summarize(error);
  const message = describeError(error);
  const failure = (failureClass: DownloadFailureClass, extra: Partial<DownloadFailure> = {}): DownloadFailure =>
    ({ failureClass, summary, retryAfterMs: 0, ...extra });

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
  if (STORAGE_FAILURE.test(message)) return failure("storage");
  if (CONTENT_FAILURE.test(message)) return failure("content");
  const name = errorName(error);
  if (name && PLUGIN_PARSE_ERROR_NAMES.has(name)) return failure("content");
  const status = httpStatus(message);
  if (status !== undefined && status < 500 && status !== 403 && status !== 408 && status !== 429) {
    return failure("content");
  }
  return failure("transient");
}

/**
 * The wait before the next fresh attempt after `attempts` recorded failures, or
 * null when the class never retries by itself or its budget is spent. Transient
 * failures get three attempts; incomplete media gets one repair attempt.
 */
export function automaticRetryDelayMs(
  failure: Pick<DownloadFailure, "failureClass" | "retryAfterMs">,
  attempts: number,
): number | null {
  const budget = failure.failureClass === "transient" ? AUTOMATIC_RETRY_BACKOFF_MS.length
    : failure.failureClass === "media-incomplete" ? 1 : 0;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > budget) return null;
  return Math.max(AUTOMATIC_RETRY_BACKOFF_MS[attempts - 1], retryAfter(failure.retryAfterMs));
}
