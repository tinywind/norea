import { useCallback, useMemo } from "react";
import enMessages from "../../strings/languages/en/app.json";
import koMessages from "../../strings/languages/ko/app.json";
import { useAppearanceStore } from "../store/appearance";
import { normalizeAppLocale, type AppLocale } from "./locales";

export type { AppLocale } from "./locales";
export { normalizeAppLocale, SUPPORTED_APP_LOCALES } from "./locales";

type TranslationMessages = typeof enMessages;
export type TranslationKey = keyof TranslationMessages;

type TranslationValues = Record<string, string | number>;

const messages: Record<AppLocale, TranslationMessages> = {
  en: enMessages,
  ko: koMessages,
};

export function translate(
  locale: AppLocale,
  key: TranslationKey,
  values?: TranslationValues,
): string {
  const resolvedLocale = normalizeAppLocale(locale);
  let message = messages[resolvedLocale][key] ?? messages.en[key] ?? key;

  if (!values) return message;

  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

export function useTranslation() {
  const appLocale = useAppearanceStore((state) => state.appLocale);
  const locale = normalizeAppLocale(appLocale);
  const t = useCallback(
    (key: TranslationKey, values?: TranslationValues) =>
      translate(locale, key, values),
    [locale],
  );

  return useMemo(() => ({ locale, t }), [locale, t]);
}

export function formatDateForLocale(
  locale: AppLocale,
  value: Date | number,
): string {
  return new Date(value).toLocaleDateString(normalizeAppLocale(locale));
}

export function formatDateTimeForLocale(
  locale: AppLocale,
  value: Date | number,
): string {
  return new Date(value).toLocaleString(normalizeAppLocale(locale));
}

export function formatTimeForLocale(locale: AppLocale, value: Date): string {
  return value.toLocaleTimeString(normalizeAppLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeTimeForLocale(
  locale: AppLocale,
  value: number | null,
  variant: "compact" | "long" = "long",
): string {
  if (value == null || value <= 0) return translate(locale, "time.never");

  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value;
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) {
    return variant === "compact"
      ? translate(locale, "time.now")
      : translate(locale, "time.justNow");
  }

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return translate(
      locale,
      variant === "compact" ? "time.minutesShort" : "time.minutesAgo",
      { count: minutes },
    );
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return translate(
      locale,
      variant === "compact" ? "time.hoursShort" : "time.hoursAgo",
      { count: hours },
    );
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return translate(
      locale,
      variant === "compact" ? "time.daysShort" : "time.daysAgo",
      { count: days },
    );
  }

  return formatDateForLocale(locale, timestamp);
}

/** Plugin catalogs name languages in English ("Japanese") or natively ("한국어"), not by code. */
const ENGLISH_LANGUAGE_NAME_CODES: Readonly<Record<string, string>> = {
  arabic: "ar",
  chinese: "zh",
  english: "en",
  french: "fr",
  german: "de",
  indonesian: "id",
  italian: "it",
  japanese: "ja",
  korean: "ko",
  polish: "pl",
  portuguese: "pt",
  russian: "ru",
  spanish: "es",
  thai: "th",
  turkish: "tr",
  ukrainian: "uk",
  vietnamese: "vi",
};

export function formatPluginLanguageForLocale(
  locale: AppLocale,
  lang: string,
): string {
  const name = lang.trim().toLowerCase();
  if (name === "multi") return translate(locale, "pluginLanguage.multi");
  const code = ENGLISH_LANGUAGE_NAME_CODES[name] ?? lang;
  try {
    const displayNames = new Intl.DisplayNames([normalizeAppLocale(locale)], {
      type: "language",
    });
    const label = displayNames.of(code);
    return label && label.toLowerCase() !== code.toLowerCase() ? label : lang;
  } catch {
    return lang;
  }
}
