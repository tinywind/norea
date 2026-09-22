import { type ScraperExecutorId } from "../tasks/scraper-queue";
import { redactUrlForLog, redactUrlsForLog } from "../url-log";
import { type PluginHttpInit } from "./types";

function mediaRequestHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function mediaRequestContextHost(contextUrl: string | undefined): string {
  if (!contextUrl) return "";
  try {
    return new URL(contextUrl).host;
  } catch {
    return "";
  }
}

export function fetchErrorMessage(error: unknown): string {
  return redactUrlsForLog(
    error instanceof Error ? error.message : String(error),
  );
}

export function mediaRequestLogContext(
  url: string,
  init: PluginHttpInit,
  scraperExecutor: ScraperExecutorId,
  status?: number,
): Record<string, number | string | undefined> {
  return {
    contextHost: mediaRequestContextHost(init.contextUrl),
    host: mediaRequestHost(url),
    sanitizedUrl: redactUrlForLog(url),
    scraperExecutor,
    sourceId: init.sourceId,
    status,
  };
}
