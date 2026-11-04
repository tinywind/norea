import type { TranslationKey } from "../i18n";

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") return error.message;
    try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
  }
  return String(error);
}

const SITE_ACCESS_ERROR = /\bcloudflare\b|\bcaptcha\b|\bcf-chl|just a moment|attention required|verification (?:is )?required|\b(?:HTTP|status)\s*40[13]\b/i;
const TIMEOUT_ERROR = /\btimed out\b|\btimeout\b|ERR_TIMED_OUT/i;
const NETWORK_ERROR = /failed to fetch|fetch failed|network ?error|networkerror|load failed|ERR_(?:CONNECTION_\w+|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|EMPTY_RESPONSE|ADDRESS_UNREACHABLE)|ECONNREFUSED|ECONNRESET|ENOTFOUND|dns error|error sending request/i;

/**
 * A plain-language message key for a failure shown to the reader, such as a
 * toast body. The raw detail stays in task rows and logs; unrecognized
 * failures get a general message instead of their raw text.
 */
export function userFacingErrorKey(error: unknown): TranslationKey {
  const message = describeError(error);
  if (SITE_ACCESS_ERROR.test(message)) return "errors.siteAccess";
  if (TIMEOUT_ERROR.test(message)) return "errors.timeout";
  if (NETWORK_ERROR.test(message)) return "errors.network";
  return "errors.generic";
}
