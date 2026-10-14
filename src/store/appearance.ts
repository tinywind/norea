import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeAppLocale, type AppLocale } from "../i18n/locales";
import { APP_THEMES, type AppThemeId } from "../theme/md3";

export type AppThemeMode = "system" | "light" | "dark";

export const MIN_ANDROID_VIEW_SCALE_PERCENT = 75;
export const MAX_ANDROID_VIEW_SCALE_PERCENT = 100;
export const MIN_FONT_SCALE_PERCENT = 75;
export const MAX_FONT_SCALE_PERCENT = 150;

interface AppearanceState {
  themeMode: AppThemeMode;
  appThemeId: AppThemeId;
  androidViewScalePercent: number;
  amoledBlack: boolean;
  customAccentColor: string;
  fontScalePercent: number;
  appLocale: AppLocale;
  showHistoryTab: boolean;
  showUpdatesTab: boolean;
  showDownloadsTab: boolean;
  showTasksTab: boolean;
  showLabelsInNav: boolean;
  setThemeMode: (themeMode: unknown) => void;
  setAppThemeId: (appThemeId: unknown) => void;
  setAndroidViewScalePercent: (androidViewScalePercent: unknown) => void;
  setAmoledBlack: (amoledBlack: boolean) => void;
  setCustomAccentColor: (customAccentColor: string) => void;
  setFontScalePercent: (fontScalePercent: unknown) => void;
  setAppLocale: (appLocale: string) => void;
  setShowHistoryTab: (showHistoryTab: boolean) => void;
  setShowUpdatesTab: (showUpdatesTab: boolean) => void;
  setShowDownloadsTab: (showDownloadsTab: boolean) => void;
  setShowTasksTab: (showTasksTab: boolean) => void;
  setShowLabelsInNav: (showLabelsInNav: boolean) => void;
  resetAppearance: () => void;
}

export const DEFAULT_APPEARANCE = {
  themeMode: "system" as AppThemeMode,
  appThemeId: "default" as AppThemeId,
  androidViewScalePercent: 100,
  amoledBlack: false,
  customAccentColor: "",
  fontScalePercent: 100,
  appLocale: "en" as AppLocale,
  showHistoryTab: true,
  showUpdatesTab: true,
  showDownloadsTab: true,
  showTasksTab: true,
  showLabelsInNav: true,
};

const APP_THEME_IDS = new Set<string>(APP_THEMES.map((theme) => theme.id));

export function normalizeAppThemeMode(themeMode: unknown): AppThemeMode {
  switch (themeMode) {
    case "system":
    case "light":
    case "dark":
      return themeMode;
    default:
      return DEFAULT_APPEARANCE.themeMode;
  }
}

export function normalizeAppThemeId(appThemeId: unknown): AppThemeId {
  return typeof appThemeId === "string" && APP_THEME_IDS.has(appThemeId)
    ? (appThemeId as AppThemeId)
    : DEFAULT_APPEARANCE.appThemeId;
}

export function normalizeAndroidViewScalePercent(
  androidViewScalePercent: unknown,
): number {
  const numeric = Number(androidViewScalePercent);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_APPEARANCE.androidViewScalePercent;
  }
  return Math.round(
    Math.min(
      MAX_ANDROID_VIEW_SCALE_PERCENT,
      Math.max(MIN_ANDROID_VIEW_SCALE_PERCENT, numeric),
    ),
  );
}

export function normalizeFontScalePercent(fontScalePercent: unknown): number {
  const numeric = Number(fontScalePercent);
  if (!Number.isFinite(numeric)) return DEFAULT_APPEARANCE.fontScalePercent;
  return Math.round(
    Math.min(MAX_FONT_SCALE_PERCENT, Math.max(MIN_FONT_SCALE_PERCENT, numeric)),
  );
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      ...DEFAULT_APPEARANCE,
      setThemeMode: (themeMode) =>
        set({ themeMode: normalizeAppThemeMode(themeMode) }),
      setAppThemeId: (appThemeId) =>
        set({ appThemeId: normalizeAppThemeId(appThemeId) }),
      setAndroidViewScalePercent: (androidViewScalePercent) =>
        set({
          androidViewScalePercent: normalizeAndroidViewScalePercent(
            androidViewScalePercent,
          ),
        }),
      setAmoledBlack: (amoledBlack) => set({ amoledBlack }),
      setCustomAccentColor: (customAccentColor) =>
        set({ customAccentColor: customAccentColor.trim() }),
      setFontScalePercent: (fontScalePercent) =>
        set({ fontScalePercent: normalizeFontScalePercent(fontScalePercent) }),
      setAppLocale: (appLocale) =>
        set({ appLocale: normalizeAppLocale(appLocale) }),
      setShowHistoryTab: (showHistoryTab) => set({ showHistoryTab }),
      setShowUpdatesTab: (showUpdatesTab) => set({ showUpdatesTab }),
      setShowDownloadsTab: (showDownloadsTab) => set({ showDownloadsTab }),
      setShowTasksTab: (showTasksTab) => set({ showTasksTab }),
      setShowLabelsInNav: (showLabelsInNav) => set({ showLabelsInNav }),
      resetAppearance: () => set({ ...DEFAULT_APPEARANCE }),
    }),
    {
      name: "app-appearance-settings",
      partialize: (state) => ({
        themeMode: state.themeMode,
        appThemeId: state.appThemeId,
        androidViewScalePercent: state.androidViewScalePercent,
        amoledBlack: state.amoledBlack,
        customAccentColor: state.customAccentColor,
        fontScalePercent: state.fontScalePercent,
        appLocale: state.appLocale,
        showHistoryTab: state.showHistoryTab,
        showUpdatesTab: state.showUpdatesTab,
        showDownloadsTab: state.showDownloadsTab,
        showTasksTab: state.showTasksTab,
        showLabelsInNav: state.showLabelsInNav,
      }),
      merge: (persistedState, currentState) => {
        if (persistedState === null || typeof persistedState !== "object") {
          return currentState;
        }
        const persistedAppearance = persistedState as Partial<AppearanceState>;
        return {
          ...currentState,
          ...persistedAppearance,
          themeMode: normalizeAppThemeMode(persistedAppearance.themeMode),
          appThemeId: normalizeAppThemeId(persistedAppearance.appThemeId),
          androidViewScalePercent: normalizeAndroidViewScalePercent(
            persistedAppearance.androidViewScalePercent,
          ),
          fontScalePercent: normalizeFontScalePercent(
            persistedAppearance.fontScalePercent,
          ),
          appLocale: normalizeAppLocale(persistedAppearance.appLocale),
        };
      },
    },
  ),
);
