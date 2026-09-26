import { type ScraperExecutorId } from "../tasks/scraper-queue";
import { redactUrlForLog } from "../url-log";
import {
  type ChapterMediaFailure,
  type ChapterMediaFinalizationErrorShape,
} from "./types";

export class ChapterMediaFinalizationError
  extends Error
  implements ChapterMediaFinalizationErrorShape
{
  readonly cause: unknown;
  readonly code = "chapter-media-finalization-failed" as const;

  constructor(cause: unknown) {
    super(`Chapter media finalization failed: ${mediaFailureMessage(cause)}`);
    this.name = "ChapterMediaFinalizationError";
    this.cause = cause;
  }
}

export function isChapterMediaFinalizationError(
  value: unknown,
): value is ChapterMediaFinalizationErrorShape {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { code?: unknown }).code === "chapter-media-finalization-failed"
  );
}

export function isMediaAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export class ChapterMediaIncompleteError extends Error {
  readonly code = "chapter-media-incomplete" as const;

  constructor(readonly failures: readonly ChapterMediaFailure[]) {
    const statuses = [...new Set(failures.map((failure) => failure.status).filter(Boolean))];
    super(`Offline download is incomplete: ${failures.length} media assets unavailable${
      statuses.length ? ` (HTTP ${statuses.join(", ")})` : ""
    }.`);
    this.name = "ChapterMediaIncompleteError";
  }
}

export class ChapterMediaHttpRetryError extends Error {
  readonly code = "chapter-media-http-retry" as const;

  constructor(readonly status: number, readonly retryAfterMs = 0) {
    super(`Media server temporarily unavailable (HTTP ${status}).`);
    this.name = "ChapterMediaHttpRetryError";
  }
}

export function mediaRetryAfterMs(value: string | null, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(86_400_000, delay)) : 0;
}

export function isTransientMediaHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function mediaFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Chromium reports dropped or reset connections with these fetch messages.
const TRANSIENT_MEDIA_NETWORK_ERROR = /\b(?:failed to fetch|network error|ERR_(?:CONNECTION_(?:CLOSED|RESET|ABORTED)|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|TIMED_OUT))\b|(?:scraper: (?:browser (?:fetch|navigation).*timed out|timed out preparing fetch context)|webview_fetch:.*(?:timeout|timed out))/i;

export function isTransientMediaNetworkError(error: unknown): boolean {
  return TRANSIENT_MEDIA_NETWORK_ERROR.test(mediaFailureMessage(error));
}

function mediaFailureHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function mediaFailureContextHost(contextUrl: string): string {
  try {
    return new URL(contextUrl).host;
  } catch {
    return "";
  }
}

export function recordChapterMediaFailure(
  failures: ChapterMediaFailure[],
  input: {
    contextUrl: string;
    error: unknown;
    scraperExecutor?: ScraperExecutorId;
    sourceId?: string;
    status?: number;
    url: string;
  },
): void {
  const message = mediaFailureMessage(input.error);
  failures.push({
    message,
    ...(input.status ? { status: input.status } : {}),
    url: input.url,
  });
  console.warn("[chapter-media] media asset using remote fallback", {
    contextHost: mediaFailureContextHost(input.contextUrl),
    error: message,
    host: mediaFailureHost(input.url),
    sanitizedUrl: redactUrlForLog(input.url),
    scraperExecutor: input.scraperExecutor,
    sourceId: input.sourceId,
    status: input.status,
  });
}
