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

function mediaFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
