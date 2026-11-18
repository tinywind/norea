/** Plugin catalogs name languages in English ("Japanese"), natively ("한국어"), or by ISO code ("ko"). */
export const ENGLISH_LANGUAGE_NAME_CODES: Readonly<Record<string, string>> = {
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

const NATIVE_LANGUAGE_NAME_CODES: Readonly<Record<string, string>> = {
  english: "en",
  한국어: "ko",
  日本語: "ja",
  中文: "zh",
  español: "es",
  français: "fr",
  deutsch: "de",
  italiano: "it",
  português: "pt",
  русский: "ru",
  polski: "pl",
  türkçe: "tr",
  українська: "uk",
  "tiếng việt": "vi",
  ไทย: "th",
  العربية: "ar",
  "bahasa indonesia": "id",
};

export function isMultiLanguageLabel(lang: string): boolean {
  return lang.trim().toLowerCase() === "multi";
}

export function resolvePluginLanguageCode(lang: string): string | null {
  const trimmed = lang.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized || isMultiLanguageLabel(normalized)) return null;
  if (ENGLISH_LANGUAGE_NAME_CODES[normalized]) {
    return ENGLISH_LANGUAGE_NAME_CODES[normalized];
  }
  if (NATIVE_LANGUAGE_NAME_CODES[trimmed] || NATIVE_LANGUAGE_NAME_CODES[normalized]) {
    return (
      NATIVE_LANGUAGE_NAME_CODES[trimmed] ??
      NATIVE_LANGUAGE_NAME_CODES[normalized]
    );
  }
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(normalized)) {
    return normalized.split("-")[0]!;
  }
  return null;
}
