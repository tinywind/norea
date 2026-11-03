import { useQuery } from "@tanstack/react-query";
import { getChapterMediaStorageRoot } from "../../lib/chapter-media-storage";
import {
  getLibrarySortField,
  LIBRARY_SORT_FIELD_LABEL_KEYS,
} from "../../lib/library-settings-options";
import type { SettingsSectionId } from "../../lib/use-settings-section";
import { useTranslation, type AppLocale, type TranslationKey } from "../../i18n";
import { useAppearanceStore, type AppThemeMode } from "../../store/appearance";
import { useContentSyncStore } from "../../store/content-sync";
import { useLibraryStore } from "../../store/library";
import type { LogLevel } from "../../store/logging";
import { useLoggingStore } from "../../store/logging";
import { usePluginVpnStore } from "../../store/plugin-vpn";
import { useReaderStore } from "../../store/reader";
import { getAppTheme, type AppThemeId } from "../../theme/md3";
import { CHAPTER_MEDIA_STORAGE_ROOT_QUERY_KEY } from "./DownloadsSection";
import { logLevelLabelKey } from "./DeveloperSection";

type Translate = (
  key: TranslationKey,
  values?: Record<string, string | number>,
) => string;

export interface SettingsSummaryState {
  appThemeId: AppThemeId;
  themeMode: AppThemeMode;
  appLocale: AppLocale;
  readerTextSize: number;
  readerPageReader: boolean;
  readerTwoPageReader: boolean;
  librarySortOrder: Parameters<typeof getLibrarySortField>[0];
  /** Undefined while the storage folder is still loading. */
  storageRoot: string | null | undefined;
  contentServerUrl: string;
  pluginVpnEnabled: boolean;
  logLevel: LogLevel;
}

const THEME_MODE_LABEL_KEYS: Record<AppThemeMode, TranslationKey> = {
  system: "settings.app.themeMode.system",
  light: "settings.app.themeMode.light",
  dark: "settings.app.themeMode.dark",
};

function lastPathSegment(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

function serverHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function readerModeLabelKey(state: SettingsSummaryState): TranslationKey {
  if (!state.readerPageReader) return "readerSettings.scroll";
  return state.readerTwoPageReader
    ? "readerSettings.twoPage"
    : "readerSettings.paged";
}

/** One-line current state for each section, shown in the section index. */
export function buildSettingsSummaries(
  state: SettingsSummaryState,
  t: Translate,
): Record<SettingsSectionId, string> {
  return {
    appearance: `${getAppTheme(state.appThemeId).label} · ${t(
      THEME_MODE_LABEL_KEYS[state.themeMode],
    )}`,
    general: t(state.appLocale === "ko" ? "locale.ko" : "locale.en"),
    reader: t("settings.summary.reader", {
      size: state.readerTextSize,
      mode: t(readerModeLabelKey(state)),
    }),
    library: t("settings.summary.library", {
      sort: t(LIBRARY_SORT_FIELD_LABEL_KEYS[getLibrarySortField(state.librarySortOrder)]),
    }),
    downloads:
      state.storageRoot === undefined
        ? t("common.loading")
        : state.storageRoot
          ? lastPathSegment(state.storageRoot)
          : t("settings.data.mediaStorage.folder.empty"),
    backup: state.contentServerUrl
      ? serverHost(state.contentServerUrl)
      : t("settings.summary.backup.noServer"),
    network: t(
      state.pluginVpnEnabled
        ? "settings.summary.network.vpnOn"
        : "settings.summary.network.vpnOff",
    ),
    reset: t("settings.summary.reset"),
    about: t("settings.summary.about"),
    developer: t("settings.summary.developer", {
      level: t(logLevelLabelKey(state.logLevel)),
    }),
  };
}

export function useSettingsSummaries(): Record<SettingsSectionId, string> {
  const { t } = useTranslation();
  const appThemeId = useAppearanceStore((state) => state.appThemeId);
  const themeMode = useAppearanceStore((state) => state.themeMode);
  const appLocale = useAppearanceStore((state) => state.appLocale);
  const readerTextSize = useReaderStore((state) => state.appearance.textSize);
  const readerPageReader = useReaderStore((state) => state.general.pageReader);
  const readerTwoPageReader = useReaderStore(
    (state) => state.general.twoPageReader,
  );
  const librarySortOrder = useLibraryStore((state) => state.sortOrder);
  const contentServerUrl = useContentSyncStore((state) => state.serverUrl);
  const pluginVpnEnabled = usePluginVpnStore((state) => state.enabled);
  const logLevel = useLoggingStore((state) => state.logLevel);
  const storageRoot = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: CHAPTER_MEDIA_STORAGE_ROOT_QUERY_KEY,
    queryFn: getChapterMediaStorageRoot,
    staleTime: Infinity,
  });

  return buildSettingsSummaries(
    {
      appThemeId,
      themeMode,
      appLocale,
      readerTextSize,
      readerPageReader,
      readerTwoPageReader,
      librarySortOrder,
      storageRoot: storageRoot.isError ? null : storageRoot.data,
      contentServerUrl,
      pluginVpnEnabled,
      logLevel,
    },
    t,
  );
}
