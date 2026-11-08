import {
  isTransientMediaHttpStatus,
  isTransientMediaNetworkError,
} from "../chapter-media/errors";
import type { ChapterMediaFailure } from "../chapter-media/types";
import type { CHAPTER_DOWNLOAD_FAILURE_CLASSES } from "../../db/schema";
import { describeError } from "../errors";
import { errorHttpStatus, isHttpNotFoundError } from "../http/status-error";
import { normalizeSourceAccessRequiredError } from "../plugins/source-access";
import { redactUrlsForLog } from "../url-log";

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
const STORAGE_FAILURE =
  /^Chapter storage failed\b|\b(?:no space left on device|disk (?:i\/o error|is full)|database or disk is full|database disk image is malformed|SQLITE_(?:FULL|IOERR|CORRUPT|READONLY|CANTOPEN)|read-only file system|os error (?:28|30)|storage (?:root|folder) (?:is )?(?:unavailable|not available))\b/i;
const CONTENT_FAILURE =
  /^(?:chapter-download: local chapter \d+ was not found|Chapter acquisition |Plugin must declare a resource acquisition plan|content-not-found:)|This chapter is not on the content server, and its source has no matching chapter\./i;
const PLUGIN_PARSE_ERROR_NAMES = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError"]);

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
 * Groups errors for diagnostics. The recovery policy separately authorizes bounded attempts.
 */
export function classifyDownloadFailure(error: unknown): DownloadFailure {
  const summary = summarize(errorCode(error) === "chapter-media-incomplete" && isHttpNotFoundError(error)
    ? `HTTP 404: ${describeError(error)}` : error);
  const message = describeError(error);
  const failure = (failureClass: DownloadFailureClass, extra: Partial<DownloadFailure> = {}): DownloadFailure =>
    ({ failureClass, summary, retryAfterMs: 0, ...extra });

  if (errorCode(error) === "chapter-storage-failed" || errorCode(error) === "chapter-media-finalization-failed") return failure("storage");
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
  if (errorCode(error) === "chapter-media-finalization-failed" || errorCode(error) === "chapter-storage-failed" || STORAGE_FAILURE.test(message)) return failure("storage");
  if (CONTENT_FAILURE.test(message)) return failure("content");
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
