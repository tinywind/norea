import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { isAbortError } from "../abort";
import { ChapterMediaIncompleteError, isTransientMediaHttpStatus, isTransientMediaNetworkError } from "../chapter-media/errors";
import { isPluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { normalizeSourceAccessRequiredError } from "../plugins/source-access";
import type { TaskRetryDecision, TaskSpec } from "./task-types";

const DOWNLOAD_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

export function isRetryableDownloadError(error: unknown): boolean {
  if (isAbortError(error) || normalizeSourceAccessRequiredError(error)) return false;
  if (isPluginVpnUnavailableError(error)) {
    return (error as { retryable?: boolean }).retryable !== false;
  }
  if (error instanceof ChapterMediaIncompleteError) {
    return error.failures.length > 0 && error.failures.every((failure) =>
      failure.status === undefined
        ? isTransientMediaNetworkError(failure.message)
        : isTransientMediaHttpStatus(failure.status),
    );
  }
  if (isTransientMediaNetworkError(error)) return true;
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "chapter-media-http-retry";
}

export function createDownloadRetryPolicy(): NonNullable<TaskSpec<unknown>["retry"]> {
  const mediaAttempts = new Map<string, number>();
  let bodyAttempts = 0;
  return (error, attempt) => {
    if (attempt === 1) {
      mediaAttempts.clear();
      bodyAttempts = 0;
    }
    let retryAttempt = attempt;
    if (error instanceof ChapterMediaIncompleteError) {
      retryAttempt = 0;
      const assets = new Set(error.failures.map((failure) => failure.fileName ?? failure.url));
      for (const asset of assets) {
        const count = (mediaAttempts.get(asset) ?? 0) + 1;
        mediaAttempts.set(asset, count);
        retryAttempt = Math.max(retryAttempt, count);
      }
    } else if (!isPluginVpnUnavailableError(error)) {
      retryAttempt = ++bodyAttempts;
    }
    return downloadRetryDecision(error, retryAttempt);
  };
}

export function downloadRetryDecision(error: unknown, attempt: number): TaskRetryDecision | null {
  if (!isRetryableDownloadError(error)) return null;
  if (!isPluginVpnUnavailableError(error) && attempt > DOWNLOAD_RETRY_DELAYS_MS.length) return null;
  const backoffMs = DOWNLOAD_RETRY_DELAYS_MS[Math.min(
    Math.max(0, Math.floor(attempt) - 1), DOWNLOAD_RETRY_DELAYS_MS.length - 1,
  )]!;
  const retryAfterMs = typeof error === "object" && error !== null && "retryAfterMs" in error
    && typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
    ? Math.min(86_400_000, Math.max(0, error.retryAfterMs)) : 0;
  const delayMs = Math.max(backoffMs, retryAfterMs);
  return {
    delayMs,
    detail: translate(useAppearanceStore.getState().appLocale, "tasks.downloadRetryWaiting", {
      seconds: delayMs / 1_000,
    }),
  };
}
