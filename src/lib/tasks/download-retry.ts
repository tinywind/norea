import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { isAbortError } from "../abort";
import { isTransientMediaNetworkError } from "../chapter-media/errors";
import { isPluginVpnUnavailableError } from "../plugin-vpn-traffic";
import type { TaskRetryDecision } from "./task-types";

const DOWNLOAD_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

export function isRetryableDownloadError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isPluginVpnUnavailableError(error)) {
    return (error as { retryable?: boolean }).retryable !== false;
  }
  if (isTransientMediaNetworkError(error)) return true;
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "chapter-media-http-retry";
}

export function downloadRetryDecision(error: unknown, attempt: number): TaskRetryDecision | null {
  if (!isRetryableDownloadError(error)) return null;
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
