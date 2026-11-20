import type { TranslationKey } from "../../i18n";
import { userFacingErrorKey } from "../errors";

export type SyncErrorTranslate = (
  key: TranslationKey,
  params?: Record<string, number | string>,
) => string;

export function contentSyncErrorKey(error: string): TranslationKey {
  if (error.startsWith("Server migration is pending for ")) {
    return "contentSync.error.migrationPending";
  }
  const key = userFacingErrorKey(error);
  if (key === "errors.network") return "contentSync.error.network";
  if (key === "errors.timeout") return "contentSync.error.timeout";
  return "contentSync.error.generic";
}

export function formatContentSyncErrorSummary(
  error: string,
  blocked: boolean,
  t: SyncErrorTranslate,
): string {
  if (blocked) return t("contentSync.blocked");
  return t(contentSyncErrorKey(error));
}

export function formatUserStateErrorSummary(
  error: string,
  blocked: boolean,
  t: SyncErrorTranslate,
): string {
  if (blocked) return t("contentSync.blocked");
  return error;
}
