import type { TranslationKey } from "../../i18n";
import type { SettingsSectionId } from "../../lib/use-settings-section";
import { SETTINGS_SECTION_TITLE_KEYS } from "./settings-section-titles";

/** One searchable settings row, keyed by the label its SettingsFieldRow shows. */
export interface SettingsSearchRow {
  section: SettingsSectionId;
  label: TranslationKey;
  /** Collapsed under the section's Advanced group until revealed. */
  advanced?: boolean;
  /** The row only renders while this holds; results explain it. */
  condition?: TranslationKey;
  /** Extra per-locale words that should find the row. */
  synonyms?: TranslationKey;
}

/**
 * Every labeled row in Settings. `settings-search-index.test.ts` fails when a
 * section gains a SettingsFieldRow label that is missing here.
 */
export const SETTINGS_SEARCH_ROWS: readonly SettingsSearchRow[] = [
  { section: "appearance", label: "settings.app.themeMode.label", synonyms: "settingsSearch.synonyms.themeMode" },
  { section: "appearance", label: "settings.app.appTheme.label", synonyms: "settingsSearch.synonyms.appTheme" },
  { section: "appearance", label: "settings.app.amoled.label" },
  { section: "appearance", label: "settings.app.fontScale.label", synonyms: "settingsSearch.synonyms.fontScale" },
  { section: "appearance", label: "settings.app.androidViewScale.label", condition: "settingsSearch.condition.android" },
  { section: "appearance", label: "settings.app.navLabels.label" },
  { section: "appearance", label: "settings.app.customAccent.label", advanced: true },

  { section: "general", label: "settings.app.locale.label", synonyms: "settingsSearch.synonyms.locale" },
  { section: "general", label: "settings.app.taskNotifications.label", synonyms: "settingsSearch.synonyms.notifications" },

  { section: "reader", label: "readerSettings.readingMode" },
  { section: "reader", label: "readerSettings.pageTransitionDuration", condition: "settingsSearch.condition.pagedMode" },
  { section: "reader", label: "readerSettings.pdfPageFitMode" },
  { section: "reader", label: "readerSettings.htmlImagePagingMode" },
  { section: "reader", label: "readerSettings.fullPageReader" },
  { section: "reader", label: "readerSettings.keepScreenOn", synonyms: "settingsSearch.synonyms.keepScreenOn" },
  { section: "reader", label: "readerSettings.readerTheme", synonyms: "settingsSearch.synonyms.readerTheme" },
  { section: "reader", label: "readerSettings.background" },
  { section: "reader", label: "readerSettings.textColor" },
  { section: "reader", label: "readerSettings.textSize", synonyms: "settingsSearch.synonyms.textSize" },
  { section: "reader", label: "readerSettings.lineHeight" },
  { section: "reader", label: "readerSettings.padding", synonyms: "settingsSearch.synonyms.padding" },
  { section: "reader", label: "readerSettings.font" },
  { section: "reader", label: "readerSettings.alignment" },
  { section: "reader", label: "readerSettings.actions" },
  { section: "reader", label: "readerSettings.swipeGestures" },
  { section: "reader", label: "readerSettings.tapControls" },
  { section: "reader", label: "readerSettings.tapPreset", condition: "settingsSearch.condition.tapControls" },
  { section: "reader", label: "readerSettings.autoScroll" },
  { section: "reader", label: "readerSettings.autoScrollInterval", condition: "settingsSearch.condition.autoScroll" },
  { section: "reader", label: "readerSettings.autoScrollOffset", condition: "settingsSearch.condition.autoScroll" },
  { section: "reader", label: "readerSettings.seekbar" },
  { section: "reader", label: "readerSettings.verticalSeekbar", condition: "settingsSearch.condition.seekbar" },
  { section: "reader", label: "readerSettings.scrollPercentage" },
  { section: "reader", label: "readerSettings.batteryTimeFooter" },
  { section: "reader", label: "readerSettings.bionicReading", advanced: true },
  { section: "reader", label: "readerSettings.removeExtraParagraphSpacing", advanced: true },
  { section: "reader", label: "readerSettings.customCssPreset", advanced: true },
  { section: "reader", label: "readerSettings.customCss", advanced: true, synonyms: "settingsSearch.synonyms.customCss" },
  { section: "reader", label: "readerSettings.customJs", advanced: true },

  { section: "library", label: "librarySettings.defaultCategory" },
  { section: "library", label: "librarySettings.sort" },
  { section: "library", label: "librarySettings.defaultChapterSort" },
  { section: "library", label: "librarySettings.checkInterval", synonyms: "settingsSearch.synonyms.checkInterval" },

  { section: "downloads", label: "settings.data.mediaStorage.folder.label", synonyms: "settingsSearch.synonyms.storage" },
  { section: "downloads", label: "settings.data.mediaStorage.change.label", synonyms: "settingsSearch.synonyms.storage" },
  { section: "downloads", label: "settings.downloads.keepAhead.label" },
  { section: "downloads", label: "settings.downloads.finishedCleanup.label", synonyms: "settingsSearch.synonyms.finishedCleanup" },
  { section: "downloads", label: "settings.downloads.mobileData.label", synonyms: "settingsSearch.synonyms.mobileData" },
  { section: "downloads", label: "settings.data.downloadedContent.label" },
  { section: "downloads", label: "browseSettings.sourceWorkConcurrency", advanced: true },
  { section: "downloads", label: "browseSettings.chapterDownloadCooldown", advanced: true },

  { section: "backup", label: "settings.data.backupFile.label", synonyms: "settingsSearch.synonyms.backup" },

  { section: "browse", label: "settings.browse.autoUpdateExtensions.label", synonyms: "settingsSearch.synonyms.extensionUpdates" },

  { section: "network", label: "settings.data.pluginVpn.status.label", condition: "settingsSearch.condition.android", synonyms: "settingsSearch.synonyms.vpn" },
  { section: "network", label: "settings.data.pluginVpn.connection.label", condition: "settingsSearch.condition.android", synonyms: "settingsSearch.synonyms.vpn" },
  { section: "network", label: "settings.data.pluginVpn.profile.label", condition: "settingsSearch.condition.android", synonyms: "settingsSearch.synonyms.vpn" },
  { section: "network", label: "settings.data.pluginVpn.credentials.label", advanced: true, condition: "settingsSearch.condition.vpnSignIn" },
  { section: "network", label: "settings.data.pluginVpn.finder.verdict.label", advanced: true, condition: "settingsSearch.condition.android" },
  { section: "network", label: "settings.data.pluginVpn.tested.label", advanced: true, condition: "settingsSearch.condition.android", synonyms: "settingsSearch.synonyms.vpn" },

  { section: "reset", label: "settings.data.libraryMembership.label" },
  { section: "reset", label: "settings.data.readingProgress.label" },
  { section: "reset", label: "settings.data.updatesQueue.label" },
  { section: "reset", label: "settings.app.reset.label" },
  { section: "reset", label: "settings.reset.reader.label" },

  { section: "about", label: "settings.about.version.label" },
  { section: "about", label: "settings.about.officialUpdate.label", synonyms: "settingsSearch.synonyms.update" },
  { section: "about", label: "settings.about.latestRelease.label" },

  { section: "developer", label: "settings.about.buildTime.label" },
  { section: "developer", label: "settings.about.platform.label" },
  { section: "developer", label: "settings.about.buildChannel.label" },
  { section: "developer", label: "settings.about.devUpdate.label" },
  { section: "developer", label: "settings.about.logLevel.label" },
  { section: "developer", label: "settings.data.webViewCache.label" },
  { section: "developer", label: "browseSettings.sourceRequestTimeout" },
  { section: "developer", label: "settings.data.userAgent.label" },
];

export interface SettingsSearchResult {
  row: SettingsSearchRow;
  /** The row's label in the current locale, which also identifies it on the page. */
  label: string;
  /** "Section › Row". */
  title: string;
  /** Global default, Advanced and condition notes, in that order. */
  notes: string[];
}

type Translate = (key: TranslationKey) => string;

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

/** Row descriptions follow the label key: `x.label` -> `x.description`, otherwise `x.description`. */
export function settingsRowDescriptionKey(label: TranslationKey): TranslationKey {
  return `${label.replace(/\.label$/, "")}.description` as TranslationKey;
}

function translated(t: Translate, key: TranslationKey | undefined): string {
  if (!key) return "";
  const text = t(key);
  return text === key ? "" : text;
}

/**
 * Rows whose label, description, synonyms or section title contain every word
 * of `query`. Label matches rank first, then index order.
 */
export function searchSettings(
  query: string,
  t: Translate,
  rows: readonly SettingsSearchRow[] = SETTINGS_SEARCH_ROWS,
): SettingsSearchResult[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const scored: Array<{ result: SettingsSearchResult; score: number }> = [];
  rows.forEach((row, index) => {
    const label = t(row.label);
    const section = t(SETTINGS_SECTION_TITLE_KEYS[row.section]);
    const normalizedLabel = normalize(label);
    const haystack = normalize([
      label,
      translated(t, settingsRowDescriptionKey(row.label)),
      translated(t, row.synonyms),
      section,
    ].join(" "));
    if (!words.every((word) => haystack.includes(word))) return;

    const labelHits = words.filter((word) => normalizedLabel.includes(word)).length;
    const notes = [
      row.section === "reader" ? t("settingsSearch.globalDefault") : "",
      row.advanced ? t("settingsSearch.advanced") : "",
      translated(t, row.condition),
    ].filter(Boolean);
    scored.push({
      result: { label, notes, row, title: `${section} › ${label}` },
      score: (normalizedLabel.startsWith(words[0]!) ? 2 : 0) + (labelHits === words.length ? 1 : 0) - index / 10_000,
    });
  });
  return scored.sort((left, right) => right.score - left.score).map(({ result }) => result);
}
