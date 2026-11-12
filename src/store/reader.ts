import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isRecord } from "../lib/type-guards";
import { parsePortableReaderAnchor, type PortableReaderAnchor } from "../lib/user-state/types";

export type ReaderPresetTheme = "paper" | "sepia" | "sage" | "dark" | "amoled";
export type ReaderTextAlign = "left" | "justify" | "center" | "right";
export type ReaderTapAction = "none" | "previous" | "menu" | "next";
export type ReaderPdfPageFitMode = "width" | "height" | "contain";
export type ReaderHtmlImagePagingMode =
  | "auto"
  | "next-page"
  | "single-image"
  | "fragment";
export type ReaderCustomCssPresetId =
  | "webtoon"
  | "webtoon-spaced"
  | "comic-spread"
  | "comic-page"
  | "page-fit-media";
export type ReaderTapPresetId =
  | "balanced"
  | "side-columns"
  | "vertical-scroll"
  | "bottom-forward-wide"
  | "top-center-previous";
export type ReaderTapZone =
  | "topLeft"
  | "topCenter"
  | "topRight"
  | "middleLeft"
  | "middleCenter"
  | "middleRight"
  | "bottomLeft"
  | "bottomCenter"
  | "bottomRight";
export type ReaderTapZoneMap = Record<ReaderTapZone, ReaderTapAction>;

export const READER_PAGE_TRANSITION_DURATION_MIN_MS = 0;
export const READER_PAGE_TRANSITION_DURATION_MAX_MS = 1000;
export const READER_PAGE_TRANSITION_DURATION_DEFAULT_MS = 180;

export interface ReaderTapPreset {
  id: ReaderTapPresetId;
  zones: ReaderTapZoneMap;
}

export interface ReaderCustomCssPreset {
  id: ReaderCustomCssPresetId;
  general?: Partial<
    Pick<
      ReaderGeneralSettings,
      "pageReader" | "twoPageReader" | "htmlImagePagingMode"
    >
  >;
  appearance?: Partial<Pick<ReaderAppearanceSettings, "padding">>;
  css: string;
}

export interface ReaderThemeDefinition {
  id: string;
  label: string;
  backgroundColor: string;
  textColor: string;
}

function createWebtoonStripCss(mediaMargin: string): string {
  return `.reader-content {
  max-width: none !important;
  width: 100% !important;
  padding: 0 !important;
}

.reader-content :where(p, figure, a),
.reader-content div:not(:where(
  [data-norea-reader-virtual-canvas],
  [data-norea-reader-virtual-window]
)) {
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  width: 100% !important;
  line-height: 0 !important;
}

.reader-content :where(img, picture, svg, video, canvas) {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
  margin: ${mediaMargin} !important;
  object-fit: contain !important;
  vertical-align: top !important;
}

.reader-content picture > img {
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
  margin: 0 auto !important;
}`;
}

const WEBTOON_STRIP_CSS = createWebtoonStripCss("0 auto");
const WEBTOON_STRIP_SPACED_CSS = createWebtoonStripCss("0 auto 1rem");

const PAGE_FIT_MEDIA_CSS = `.reader-viewport-paged .reader-content {
  --norea-page-fit-media-height: var(--norea-reader-page-media-max-height, 100dvh);
}

.reader-viewport-paged .reader-content :where(p, div, figure, a):has(> :where(img, picture, svg, video, canvas):only-child) {
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}

.reader-viewport-paged .reader-content :where(img, picture, svg, video, canvas) {
  display: block !important;
  max-width: 100% !important;
  max-height: var(--norea-page-fit-media-height) !important;
  width: auto !important;
  height: auto !important;
  object-fit: contain !important;
  margin-inline: auto !important;
}

.reader-viewport-paged .reader-content picture > img {
  max-height: var(--norea-page-fit-media-height) !important;
  width: auto !important;
  height: auto !important;
}`;

export interface ReaderGeneralSettings {
  fullPageReader: boolean;
  keepScreenOn: boolean;
  pageReader: boolean;
  twoPageReader: boolean;
  pageTransitionDuration: number;
  swipeGestures: boolean;
  tapToScroll: boolean;
  showSeekbar: boolean;
  verticalSeekbar: boolean;
  pdfPageFitMode: ReaderPdfPageFitMode;
  htmlImagePagingMode: ReaderHtmlImagePagingMode;
  showScrollPercentage: boolean;
  showBatteryAndTime: boolean;
  autoScroll: boolean;
  autoScrollInterval: number;
  autoScrollOffset: number;
  /** Retired "Download next chapter in advance"; kept so download goals can read it once (RD4). */
  autoDownloadNextChapter: boolean;
  bionicReading: boolean;
  removeExtraParagraphSpacing: boolean;
  tapZonePresetId: ReaderTapPresetId;
  tapZones: ReaderTapZoneMap;
}

export interface ReaderAppearanceSettings {
  themeId: string;
  backgroundColor: string;
  textColor: string;
  textSize: number;
  textAlign: ReaderTextAlign;
  padding: number;
  fontFamily: string;
  lineHeight: number;
  customCss: string;
  customJs: string;
  customThemes: ReaderThemeDefinition[];
}

export type ReaderGeneralSettingsOverride = Partial<ReaderGeneralSettings>;

export type ReaderAppearanceSettingsOverride = Partial<
  Omit<ReaderAppearanceSettings, "customThemes">
>;

export interface ReaderSettingsOverride {
  enabled: boolean;
  general?: ReaderGeneralSettingsOverride;
  appearance?: ReaderAppearanceSettingsOverride;
}

export type ReaderNovelSettingsOverride = ReaderSettingsOverride;
export type ReaderSourceSettingsOverride = ReaderSettingsOverride;

/** A scope narrower than all novels whose settings can be copied to them. */
export type ReaderSettingsNarrowScope =
  | { kind: "source"; sourceId: string }
  | { kind: "novel"; novelId: number; sourceId?: string | null };

export interface MergeNovelReaderStateInput {
  sourceNovelId: number;
  targetNovelId: number;
  chapterIdMap: Readonly<Record<number, number>>;
  preferredLastReadChapterId?: number | null;
}

/** Scroll-mode reading position inside one chapter: the content block at the top of the viewport. */
export interface ReaderScrollAnchor {
  /** `data-norea-reader-segment-index` of the top-visible content block. */
  segmentIndex: number;
  /** Position of the top-visible image or video among the media of that block. */
  mediaOrdinal?: number;
  /** Fraction of the anchored element's height above the viewport top, 0 to 1. */
  offset: number;
  /** Segment count of the document the anchor was taken from. */
  segmentCount: number;
}

export interface ReaderChapterScrollAnchor extends ReaderScrollAnchor {
  novelId: number;
  /** Chapter progress the reader saved together with this anchor. */
  progress: number;
  savedAt: number;
}

export const READER_CHAPTER_SCROLL_ANCHOR_LIMIT = 100;

export interface SharedReaderResumeInput {
  novelId: number;
  chapterId: number | null;
  anchor: PortableReaderAnchor | null;
  openedAt: number | null;
}

let applyingSharedResume = 0;

export function applySharedReaderState(update: () => void): void {
  applyingSharedResume++;
  try { update(); } finally { applyingSharedResume--; }
}

export function isApplyingSharedReaderResume(): boolean {
  return applyingSharedResume > 0;
}

/** Only document-relative fields may leave this device. */
export function getPortableReaderAnchor(
  anchor: ReaderChapterScrollAnchor | null | undefined,
): PortableReaderAnchor | null {
  if (!anchor) return null;
  const checked = normalizeChapterScrollAnchors({ 1: anchor })[1];
  if (!checked) return null;
  const { segmentIndex, segmentCount, offset, mediaOrdinal, progress, savedAt } = checked;
  try {
    return parsePortableReaderAnchor({
      segmentIndex, segmentCount, offset, progress, savedAt,
      ...(mediaOrdinal === undefined ? {} : { mediaOrdinal }),
    });
  } catch {
    return null;
  }
}

interface ReaderState {
  general: ReaderGeneralSettings;
  appearance: ReaderAppearanceSettings;
  lastReadChapterByNovel: Record<number, number>;
  novelPageIndexByNovel: Record<number, number>;
  chapterScrollAnchors: Record<number, ReaderChapterScrollAnchor>;
  readerSettingsByNovel: Record<number, ReaderNovelSettingsOverride>;
  readerSettingsBySource: Record<string, ReaderSourceSettingsOverride>;
  setGeneral: (settings: Partial<ReaderGeneralSettings>) => void;
  setAppearance: (settings: Partial<ReaderAppearanceSettings>) => void;
  setSourceReaderSettingsEnabled: (sourceId: string, enabled: boolean) => void;
  setSourceGeneral: (
    sourceId: string,
    settings: Partial<ReaderGeneralSettings>,
  ) => void;
  setSourceAppearance: (
    sourceId: string,
    settings: Partial<ReaderAppearanceSettings>,
  ) => void;
  setNovelReaderSettingsEnabled: (novelId: number, enabled: boolean) => void;
  /**
   * Turns the source override on starting from the values it inherits, so
   * nothing the reader shows changes. An override that is on is kept.
   */
  startSourceReaderSettings: (sourceId: string) => void;
  /**
   * Turns the novel override on starting from the values it inherits, so
   * nothing the reader shows changes. An override that is on is kept.
   */
  startNovelReaderSettings: (novelId: number) => void;
  /**
   * Makes a scope's effective settings the settings for all novels and turns
   * that scope's override off, so the scope now follows all novels.
   */
  copyReaderSettingsToGlobal: (scope: ReaderSettingsNarrowScope) => void;
  setNovelGeneral: (
    novelId: number,
    settings: Partial<ReaderGeneralSettings>,
    baseGeneral?: ReaderGeneralSettings,
  ) => void;
  setNovelAppearance: (
    novelId: number,
    settings: Partial<ReaderAppearanceSettings>,
    baseAppearance?: ReaderAppearanceSettings,
  ) => void;
  applyTheme: (theme: ReaderThemeDefinition) => void;
  applySourceTheme: (sourceId: string, theme: ReaderThemeDefinition) => void;
  applyNovelTheme: (
    novelId: number,
    theme: ReaderThemeDefinition,
    baseAppearance?: ReaderAppearanceSettings,
  ) => void;
  saveCustomTheme: (theme: ReaderThemeDefinition) => void;
  deleteCustomTheme: (themeId: string) => void;
  applyTapZonePreset: (presetId: ReaderTapPresetId) => void;
  setLastReadChapter: (novelId: number, chapterId: number) => void;
  applySharedResume: (input: SharedReaderResumeInput) => void;
  setNovelPageIndex: (novelId: number, pageIndex: number) => void;
  /** Saves or, with `null`, forgets the scroll anchor of one chapter. */
  setChapterScrollAnchor: (
    chapterId: number,
    anchor: Omit<ReaderChapterScrollAnchor, "savedAt"> | null,
  ) => void;
  mergeNovelReaderState: (input: MergeNovelReaderStateInput) => void;
  removeNovelReaderState: (novelId: number) => void;
  resetReadingProgress: () => void;
  resetSourceReaderSettings: (sourceId: string) => void;
  resetNovelReaderSettings: (novelId: number) => void;
  resetReaderSettings: (options?: { keepScopedSettings?: boolean }) => void;
}

export const READER_PRESET_THEMES: ReaderThemeDefinition[] = [
  {
    id: "paper",
    label: "Paper",
    backgroundColor: "#f5f5fa",
    textColor: "#111111",
  },
  {
    id: "sepia",
    label: "Sepia",
    backgroundColor: "#F7DFC6",
    textColor: "#593100",
  },
  {
    id: "sage",
    label: "Sage",
    backgroundColor: "#dce5e2",
    textColor: "#000000",
  },
  {
    id: "dark",
    label: "Dark",
    backgroundColor: "#292832",
    textColor: "#CCCCCC",
  },
  {
    id: "amoled",
    label: "AMOLED",
    backgroundColor: "#000000",
    textColor: "#FFFFFF",
  },
];

export const READER_FONT_OPTIONS = [
  { value: "", label: "Original" },
  { value: "Lora, Georgia, serif", label: "Lora" },
  { value: "Nunito, Arial, sans-serif", label: "Nunito" },
  { value: "\"Noto Sans\", Arial, sans-serif", label: "Noto Sans" },
  { value: "\"Open Sans\", Arial, sans-serif", label: "Open Sans" },
  { value: "\"Arbutus Slab\", Georgia, serif", label: "Arbutus Slab" },
  { value: "Domine, Georgia, serif", label: "Domine" },
  { value: "Lato, Arial, sans-serif", label: "Lato" },
  { value: "\"PT Serif\", Georgia, serif", label: "PT Serif" },
  { value: "OpenDyslexic, Arial, sans-serif", label: "OpenDyslexic" },
];

export const READER_CUSTOM_CSS_PRESETS: ReaderCustomCssPreset[] = [
  {
    id: "webtoon",
    general: {
      pageReader: false,
      twoPageReader: false,
      htmlImagePagingMode: "auto",
    },
    appearance: {
      padding: 0,
    },
    css: WEBTOON_STRIP_CSS,
  },
  {
    id: "webtoon-spaced",
    general: {
      pageReader: false,
      twoPageReader: false,
      htmlImagePagingMode: "auto",
    },
    appearance: {
      padding: 0,
    },
    css: WEBTOON_STRIP_SPACED_CSS,
  },
  {
    id: "comic-spread",
    general: {
      pageReader: true,
      twoPageReader: true,
      htmlImagePagingMode: "single-image",
    },
    appearance: {
      padding: 0,
    },
    css: `.reader-content {
  max-width: none !important;
  width: 100% !important;
  padding: 0 !important;
}

.reader-viewport-paged .reader-content {
  column-gap: 0 !important;
}

.reader-content > :where(p, div, figure, a) {
  margin: 0 !important;
  padding: 0 !important;
  width: 100% !important;
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}

.reader-content :where(img, picture, svg, video, canvas) {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
  margin: 0 auto !important;
  object-fit: contain !important;
  background: #fff !important;
}

.reader-content picture > img {
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
}`,
  },
  {
    id: "comic-page",
    general: {
      pageReader: true,
      twoPageReader: false,
      htmlImagePagingMode: "single-image",
    },
    appearance: {
      padding: 0,
    },
    css: `.reader-content {
  max-width: none !important;
  width: 100% !important;
  padding: 0 !important;
}

.reader-viewport-paged .reader-content {
  column-gap: 0 !important;
}

.reader-content > :where(p, div, figure, a) {
  margin: 0 !important;
  padding: 0 !important;
  width: 100% !important;
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}

.reader-content :where(img, picture, svg, video, canvas) {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
  margin: 0 auto !important;
  object-fit: contain !important;
  background: #fff !important;
}

.reader-content picture > img {
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
}`,
  },
  {
    id: "page-fit-media",
    css: PAGE_FIT_MEDIA_CSS,
  },
];

const DEFAULT_READER_THEME = READER_PRESET_THEMES[3]!;

const READER_GENERAL_OVERRIDE_KEYS: Array<keyof ReaderGeneralSettingsOverride> =
  [
    "fullPageReader",
    "keepScreenOn",
    "pageReader",
    "twoPageReader",
    "pageTransitionDuration",
    "swipeGestures",
    "tapToScroll",
    "showSeekbar",
    "verticalSeekbar",
    "pdfPageFitMode",
    "htmlImagePagingMode",
    "showScrollPercentage",
    "showBatteryAndTime",
    "autoScroll",
    "autoScrollInterval",
    "autoScrollOffset",
    "autoDownloadNextChapter",
    "bionicReading",
    "removeExtraParagraphSpacing",
    "tapZonePresetId",
    "tapZones",
  ];

const READER_APPEARANCE_OVERRIDE_KEYS: Array<
  keyof ReaderAppearanceSettingsOverride
> = [
  "themeId",
  "backgroundColor",
  "textColor",
  "textSize",
  "textAlign",
  "padding",
  "fontFamily",
  "lineHeight",
  "customCss",
  "customJs",
];

export const READER_TAP_ZONES: ReaderTapZone[] = [
  "topLeft",
  "topCenter",
  "topRight",
  "middleLeft",
  "middleCenter",
  "middleRight",
  "bottomLeft",
  "bottomCenter",
  "bottomRight",
];

export const READER_TAP_PRESETS: ReaderTapPreset[] = [
  {
    id: "balanced",
    zones: {
      topLeft: "previous",
      topCenter: "previous",
      topRight: "previous",
      middleLeft: "previous",
      middleCenter: "menu",
      middleRight: "next",
      bottomLeft: "next",
      bottomCenter: "next",
      bottomRight: "next",
    },
  },
  {
    id: "side-columns",
    zones: {
      topLeft: "previous",
      topCenter: "menu",
      topRight: "next",
      middleLeft: "previous",
      middleCenter: "menu",
      middleRight: "next",
      bottomLeft: "previous",
      bottomCenter: "menu",
      bottomRight: "next",
    },
  },
  {
    id: "vertical-scroll",
    zones: {
      topLeft: "previous",
      topCenter: "previous",
      topRight: "previous",
      middleLeft: "menu",
      middleCenter: "menu",
      middleRight: "menu",
      bottomLeft: "next",
      bottomCenter: "next",
      bottomRight: "next",
    },
  },
  {
    id: "bottom-forward-wide",
    zones: {
      topLeft: "previous",
      topCenter: "menu",
      topRight: "next",
      middleLeft: "previous",
      middleCenter: "menu",
      middleRight: "next",
      bottomLeft: "next",
      bottomCenter: "next",
      bottomRight: "next",
    },
  },
  {
    id: "top-center-previous",
    zones: {
      topLeft: "next",
      topCenter: "previous",
      topRight: "next",
      middleLeft: "next",
      middleCenter: "menu",
      middleRight: "next",
      bottomLeft: "next",
      bottomCenter: "next",
      bottomRight: "next",
    },
  },
];

const DEFAULT_TAP_ZONE_PRESET = READER_TAP_PRESETS[0]!;

export const TAP_ZONE_DEFAULTS = DEFAULT_TAP_ZONE_PRESET.zones;

export const READER_GENERAL_DEFAULTS: ReaderGeneralSettings = {
  fullPageReader: false,
  keepScreenOn: false,
  pageReader: false,
  twoPageReader: false,
  pageTransitionDuration: READER_PAGE_TRANSITION_DURATION_DEFAULT_MS,
  swipeGestures: true,
  tapToScroll: true,
  showSeekbar: true,
  verticalSeekbar: false,
  pdfPageFitMode: "width",
  htmlImagePagingMode: "auto",
  showScrollPercentage: true,
  showBatteryAndTime: true,
  autoScroll: false,
  autoScrollInterval: 80,
  autoScrollOffset: 1,
  autoDownloadNextChapter: true,
  bionicReading: false,
  removeExtraParagraphSpacing: false,
  tapZonePresetId: DEFAULT_TAP_ZONE_PRESET.id,
  tapZones: TAP_ZONE_DEFAULTS,
};

export const READER_APPEARANCE_DEFAULTS: ReaderAppearanceSettings = {
  themeId: DEFAULT_READER_THEME.id,
  backgroundColor: DEFAULT_READER_THEME.backgroundColor,
  textColor: DEFAULT_READER_THEME.textColor,
  textSize: 16,
  textAlign: "left",
  padding: 16,
  fontFamily: "",
  lineHeight: 1.5,
  customCss: "",
  customJs: "",
  customThemes: [],
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizePdfPageFitMode(value: unknown): ReaderPdfPageFitMode {
  if (value === "height" || value === "contain") {
    return value;
  }
  return "width";
}

function normalizeHtmlImagePagingMode(value: unknown): ReaderHtmlImagePagingMode {
  if (
    value === "next-page" ||
    value === "single-image" ||
    value === "fragment"
  ) {
    return value;
  }
  return "auto";
}

function normalizeGeneral(
  settings: Partial<ReaderGeneralSettings>,
): Partial<ReaderGeneralSettings> {
  const normalized: Partial<ReaderGeneralSettings> = {
    ...settings,
    ...(settings.autoScrollInterval !== undefined
      ? {
          autoScrollInterval: Math.round(
            clamp(settings.autoScrollInterval, 16, 500),
          ),
        }
      : {}),
    ...(settings.pageTransitionDuration !== undefined
      ? {
          pageTransitionDuration: Math.round(
            clamp(
              settings.pageTransitionDuration,
              READER_PAGE_TRANSITION_DURATION_MIN_MS,
              READER_PAGE_TRANSITION_DURATION_MAX_MS,
            ),
          ),
        }
      : {}),
    ...(settings.autoScrollOffset !== undefined
      ? { autoScrollOffset: clamp(settings.autoScrollOffset, 0.25, 12) }
      : {}),
    ...(settings.tapZonePresetId !== undefined
      ? { tapZonePresetId: normalizeTapZonePresetId(settings.tapZonePresetId) }
      : {}),
    ...(settings.tapZones !== undefined
      ? {
          tapZones: normalizeTapZones(settings.tapZones, TAP_ZONE_DEFAULTS),
        }
      : {}),
    ...(settings.pdfPageFitMode !== undefined
      ? { pdfPageFitMode: normalizePdfPageFitMode(settings.pdfPageFitMode) }
      : {}),
    ...(settings.htmlImagePagingMode !== undefined
      ? {
          htmlImagePagingMode: normalizeHtmlImagePagingMode(
            settings.htmlImagePagingMode,
          ),
        }
      : {}),
  };

  if (settings.twoPageReader === true) {
    normalized.pageReader = true;
  }
  if (settings.pageReader === false) {
    normalized.twoPageReader = false;
  }

  return normalized;
}

/** Removed presets whose zone maps match a remaining preset. */
const RETIRED_TAP_PRESET_IDS: Readonly<Record<string, ReaderTapPresetId>> = {
  "bottom-forward": "balanced",
};

function normalizeTapZonePresetId(value: unknown): ReaderTapPresetId {
  const presetId =
    typeof value === "string" ? (RETIRED_TAP_PRESET_IDS[value] ?? value) : value;
  return READER_TAP_PRESETS.some((preset) => preset.id === presetId)
    ? (presetId as ReaderTapPresetId)
    : DEFAULT_TAP_ZONE_PRESET.id;
}

function getTapZonePreset(presetId: ReaderTapPresetId): ReaderTapPreset {
  return (
    READER_TAP_PRESETS.find((preset) => preset.id === presetId) ??
    DEFAULT_TAP_ZONE_PRESET
  );
}

function isTapAction(value: unknown): value is ReaderTapAction {
  return (
    value === "none" ||
    value === "previous" ||
    value === "menu" ||
    value === "next"
  );
}

function normalizeTapZones(
  zones: Partial<ReaderTapZoneMap>,
  fallback: ReaderTapZoneMap,
): ReaderTapZoneMap {
  const next = { ...fallback };
  for (const zone of READER_TAP_ZONES) {
    const action = zones[zone];
    if (isTapAction(action)) {
      next[zone] = action;
    }
  }
  next.middleCenter = "menu";
  return next;
}

function normalizeAppearance(
  settings: Partial<ReaderAppearanceSettings>,
): Partial<ReaderAppearanceSettings> {
  return {
    ...settings,
    ...(settings.textSize !== undefined
      ? { textSize: Math.round(clamp(settings.textSize, 12, 36)) }
      : {}),
    ...(settings.padding !== undefined
      ? { padding: Math.round(clamp(settings.padding, 0, 64)) }
      : {}),
    ...(settings.lineHeight !== undefined
      ? { lineHeight: clamp(settings.lineHeight, 1, 2.6) }
      : {}),
  };
}

function normalizeAppearanceOverride(
  settings: Partial<ReaderAppearanceSettings>,
): ReaderAppearanceSettingsOverride {
  const { customThemes: _customThemes, ...override } = normalizeAppearance(
    settings,
  );
  return override;
}

function areSettingValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (isRecord(left) && isRecord(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function isEmptyRecord(value: object | undefined): boolean {
  return !value || Object.keys(value).length === 0;
}

function assignGeneralOverrideValue(
  target: ReaderGeneralSettingsOverride,
  key: keyof ReaderGeneralSettingsOverride,
  value: unknown,
): void {
  (target as Partial<Record<keyof ReaderGeneralSettingsOverride, unknown>>)[
    key
  ] = value;
}

function assignAppearanceOverrideValue(
  target: ReaderAppearanceSettingsOverride,
  key: keyof ReaderAppearanceSettingsOverride,
  value: unknown,
): void {
  (
    target as Partial<Record<keyof ReaderAppearanceSettingsOverride, unknown>>
  )[key] = value;
}

function getNextGeneralOverride(
  globalGeneral: ReaderGeneralSettings,
  currentOverride: ReaderGeneralSettingsOverride | undefined,
  settings: Partial<ReaderGeneralSettings>,
): ReaderGeneralSettingsOverride {
  const normalizedSettings = normalizeGeneral(settings);
  const currentEffective = {
    ...globalGeneral,
    ...(currentOverride ?? {}),
  };
  const nextEffective = {
    ...currentEffective,
    ...normalizedSettings,
  };
  const nextOverride: ReaderGeneralSettingsOverride = {
    ...(currentOverride ?? {}),
  };

  for (const key of READER_GENERAL_OVERRIDE_KEYS) {
    if (normalizedSettings[key] === undefined) continue;
    const value = nextEffective[key];
    if (areSettingValuesEqual(value, globalGeneral[key])) {
      delete nextOverride[key];
    } else {
      assignGeneralOverrideValue(nextOverride, key, value);
    }
  }

  return nextOverride;
}

function getNextAppearanceOverride(
  globalAppearance: ReaderAppearanceSettings,
  currentOverride: ReaderAppearanceSettingsOverride | undefined,
  settings: Partial<ReaderAppearanceSettings>,
): ReaderAppearanceSettingsOverride {
  const normalizedSettings = normalizeAppearanceOverride(settings);
  const currentEffective = {
    ...globalAppearance,
    ...(currentOverride ?? {}),
  };
  const nextEffective = {
    ...currentEffective,
    ...normalizedSettings,
  };
  const nextOverride: ReaderAppearanceSettingsOverride = {
    ...(currentOverride ?? {}),
  };

  for (const key of Object.keys(
    normalizedSettings,
  ) as Array<keyof ReaderAppearanceSettingsOverride>) {
    const value = nextEffective[key];
    if (areSettingValuesEqual(value, globalAppearance[key])) {
      delete nextOverride[key];
    } else {
      assignAppearanceOverrideValue(nextOverride, key, value);
    }
  }

  return nextOverride;
}

function normalizeReaderSettingsOverrideEntry(
  entry: unknown,
): ReaderSettingsOverride | null {
  if (!isRecord(entry)) return null;
  const nextOverride: ReaderSettingsOverride = {
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
  };
  if (isRecord(entry.general)) {
    const general = normalizeGeneral(
      entry.general as Partial<ReaderGeneralSettings>,
    );
    for (const key of READER_GENERAL_OVERRIDE_KEYS) {
      if (general[key] !== undefined) {
        const nextGeneral = nextOverride.general ?? {};
        assignGeneralOverrideValue(
          nextGeneral,
          key,
          general[key],
        );
        nextOverride.general = nextGeneral;
      }
    }
  }
  if (isRecord(entry.appearance)) {
    const appearance = normalizeAppearanceOverride(
      entry.appearance as Partial<ReaderAppearanceSettings>,
    );
    for (const key of READER_APPEARANCE_OVERRIDE_KEYS) {
      if (appearance[key] !== undefined) {
        const nextAppearance = nextOverride.appearance ?? {};
        assignAppearanceOverrideValue(
          nextAppearance,
          key,
          appearance[key],
        );
        nextOverride.appearance = nextAppearance;
      }
    }
  }
  return nextOverride;
}

function limitChapterScrollAnchors(
  anchors: Record<number, ReaderChapterScrollAnchor>,
): Record<number, ReaderChapterScrollAnchor> {
  const entries = Object.entries(anchors);
  if (entries.length <= READER_CHAPTER_SCROLL_ANCHOR_LIMIT) return anchors;
  return Object.fromEntries(
    entries
      .sort(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, READER_CHAPTER_SCROLL_ANCHOR_LIMIT),
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function normalizeChapterScrollAnchors(
  value: unknown,
): Record<number, ReaderChapterScrollAnchor> {
  if (!isRecord(value)) return {};
  const anchors: Record<number, ReaderChapterScrollAnchor> = {};
  for (const [key, entry] of Object.entries(value)) {
    const chapterId = Number(key);
    if (!Number.isInteger(chapterId) || chapterId <= 0 || !isRecord(entry)) {
      continue;
    }
    const { mediaOrdinal, novelId, offset, progress, savedAt, segmentCount, segmentIndex } =
      entry;
    if (
      !isNonNegativeInteger(novelId) ||
      !isNonNegativeInteger(segmentIndex) ||
      !isNonNegativeInteger(segmentCount) ||
      segmentIndex >= segmentCount ||
      typeof offset !== "number" ||
      !(offset >= 0 && offset <= 1) ||
      typeof progress !== "number" ||
      !(progress >= 0 && progress <= 100) ||
      typeof savedAt !== "number" ||
      !Number.isFinite(savedAt) ||
      (mediaOrdinal !== undefined && !isNonNegativeInteger(mediaOrdinal))
    ) {
      continue;
    }
    anchors[chapterId] = {
      novelId,
      progress,
      savedAt,
      segmentCount,
      segmentIndex,
      offset,
      ...(mediaOrdinal === undefined ? {} : { mediaOrdinal }),
    };
  }
  return limitChapterScrollAnchors(anchors);
}

function normalizeReaderSettingsByNovel(
  value: unknown,
): Record<number, ReaderNovelSettingsOverride> {
  if (!isRecord(value)) return {};
  const normalized: Record<number, ReaderNovelSettingsOverride> = {};
  for (const [novelId, entry] of Object.entries(value)) {
    const parsedNovelId = Number(novelId);
    if (!Number.isFinite(parsedNovelId)) continue;
    const nextOverride = normalizeReaderSettingsOverrideEntry(entry);
    if (!nextOverride) continue;
    normalized[parsedNovelId] = nextOverride;
  }
  return normalized;
}

function normalizeReaderSettingsBySource(
  value: unknown,
): Record<string, ReaderSourceSettingsOverride> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, ReaderSourceSettingsOverride> = {};
  for (const [sourceId, entry] of Object.entries(value)) {
    if (sourceId.trim().length === 0) continue;
    const nextOverride = normalizeReaderSettingsOverrideEntry(entry);
    if (!nextOverride) continue;
    normalized[sourceId] = nextOverride;
  }
  return normalized;
}

function setNovelOverride(
  overrides: Record<number, ReaderNovelSettingsOverride>,
  novelId: number,
  override: ReaderNovelSettingsOverride,
): Record<number, ReaderNovelSettingsOverride> {
  return {
    ...overrides,
    [novelId]: override,
  };
}

function setSourceOverride(
  overrides: Record<string, ReaderSourceSettingsOverride>,
  sourceId: string,
  override: ReaderSourceSettingsOverride,
): Record<string, ReaderSourceSettingsOverride> {
  return {
    ...overrides,
    [sourceId]: override,
  };
}

export function getEffectiveReaderGeneralSettings(
  general: ReaderGeneralSettings,
  ...overrides: Array<ReaderSettingsOverride | undefined>
): ReaderGeneralSettings {
  return overrides.reduce(
    (current, override) =>
      override?.enabled
        ? {
            ...current,
            ...(override.general ?? {}),
          }
        : current,
    general,
  );
}

export function getEffectiveReaderAppearanceSettings(
  appearance: ReaderAppearanceSettings,
  ...overrides: Array<ReaderSettingsOverride | undefined>
): ReaderAppearanceSettings {
  return overrides.reduce(
    (current, override) =>
      override?.enabled
        ? {
            ...current,
            ...(override.appearance ?? {}),
            customThemes: appearance.customThemes,
          }
        : current,
    appearance,
  );
}

export const useReaderStore = create<ReaderState>()(
  persist(
    (set) => ({
      general: READER_GENERAL_DEFAULTS,
      appearance: READER_APPEARANCE_DEFAULTS,
      lastReadChapterByNovel: {},
      novelPageIndexByNovel: {},
      chapterScrollAnchors: {},
      readerSettingsByNovel: {},
      readerSettingsBySource: {},
      setGeneral: (settings) =>
        set((state) => ({
          general: {
            ...state.general,
            ...normalizeGeneral(settings),
          },
        })),
      setAppearance: (settings) =>
        set((state) => ({
          appearance: {
            ...state.appearance,
            ...normalizeAppearance(settings),
          },
        })),
      setSourceReaderSettingsEnabled: (sourceId, enabled) =>
        set((state) => {
          const existing = state.readerSettingsBySource[sourceId];
          if (!existing && !enabled) return state;
          return {
            readerSettingsBySource: setSourceOverride(
              state.readerSettingsBySource,
              sourceId,
              {
                ...(existing ?? {}),
                enabled,
              },
            ),
          };
        }),
      setSourceGeneral: (sourceId, settings) =>
        set((state) => {
          const existing = state.readerSettingsBySource[sourceId];
          const general = getNextGeneralOverride(
            state.general,
            existing?.general,
            settings,
          );
          const nextOverride: ReaderSourceSettingsOverride = {
            ...(existing ?? { enabled: true }),
          };
          if (isEmptyRecord(general)) {
            delete nextOverride.general;
          } else {
            nextOverride.general = general;
          }
          return {
            readerSettingsBySource: setSourceOverride(
              state.readerSettingsBySource,
              sourceId,
              nextOverride,
            ),
          };
        }),
      setSourceAppearance: (sourceId, settings) =>
        set((state) => {
          const existing = state.readerSettingsBySource[sourceId];
          const appearance = getNextAppearanceOverride(
            state.appearance,
            existing?.appearance,
            settings,
          );
          const nextOverride: ReaderSourceSettingsOverride = {
            ...(existing ?? { enabled: true }),
          };
          if (isEmptyRecord(appearance)) {
            delete nextOverride.appearance;
          } else {
            nextOverride.appearance = appearance;
          }
          return {
            readerSettingsBySource: setSourceOverride(
              state.readerSettingsBySource,
              sourceId,
              nextOverride,
            ),
          };
        }),
      setNovelReaderSettingsEnabled: (novelId, enabled) =>
        set((state) => {
          const existing = state.readerSettingsByNovel[novelId];
          if (!existing && !enabled) return state;
          return {
            readerSettingsByNovel: setNovelOverride(
              state.readerSettingsByNovel,
              novelId,
              {
                ...(existing ?? {}),
                enabled,
              },
            ),
          };
        }),
      startSourceReaderSettings: (sourceId) =>
        set((state) =>
          state.readerSettingsBySource[sourceId]?.enabled
            ? state
            : {
                readerSettingsBySource: setSourceOverride(
                  state.readerSettingsBySource,
                  sourceId,
                  { enabled: true },
                ),
              },
        ),
      startNovelReaderSettings: (novelId) =>
        set((state) =>
          state.readerSettingsByNovel[novelId]?.enabled
            ? state
            : {
                readerSettingsByNovel: setNovelOverride(
                  state.readerSettingsByNovel,
                  novelId,
                  { enabled: true },
                ),
              },
        ),
      copyReaderSettingsToGlobal: (scope) =>
        set((state) => {
          const sourceOverride = scope.sourceId
            ? state.readerSettingsBySource[scope.sourceId]
            : undefined;
          const novelOverride =
            scope.kind === "novel"
              ? state.readerSettingsByNovel[scope.novelId]
              : undefined;
          const scopeOverride =
            scope.kind === "novel" ? novelOverride : sourceOverride;
          if (!scopeOverride?.enabled) return state;
          const general = getEffectiveReaderGeneralSettings(
            state.general,
            sourceOverride,
            novelOverride,
          );
          const appearance = getEffectiveReaderAppearanceSettings(
            state.appearance,
            sourceOverride,
            novelOverride,
          );
          const disabled = { ...scopeOverride, enabled: false };
          return scope.kind === "novel"
            ? {
                appearance,
                general,
                readerSettingsByNovel: setNovelOverride(
                  state.readerSettingsByNovel,
                  scope.novelId,
                  disabled,
                ),
              }
            : {
                appearance,
                general,
                readerSettingsBySource: setSourceOverride(
                  state.readerSettingsBySource,
                  scope.sourceId,
                  disabled,
                ),
              };
        }),
      setNovelGeneral: (novelId, settings, baseGeneral) =>
        set((state) => {
          const existing = state.readerSettingsByNovel[novelId];
          const general = getNextGeneralOverride(
            baseGeneral ?? state.general,
            existing?.general,
            settings,
          );
          const nextOverride: ReaderNovelSettingsOverride = {
            ...(existing ?? { enabled: true }),
          };
          if (isEmptyRecord(general)) {
            delete nextOverride.general;
          } else {
            nextOverride.general = general;
          }
          return {
            readerSettingsByNovel: setNovelOverride(
              state.readerSettingsByNovel,
              novelId,
              nextOverride,
            ),
          };
        }),
      setNovelAppearance: (novelId, settings, baseAppearance) =>
        set((state) => {
          const existing = state.readerSettingsByNovel[novelId];
          const appearance = getNextAppearanceOverride(
            baseAppearance ?? state.appearance,
            existing?.appearance,
            settings,
          );
          const nextOverride: ReaderNovelSettingsOverride = {
            ...(existing ?? { enabled: true }),
          };
          if (isEmptyRecord(appearance)) {
            delete nextOverride.appearance;
          } else {
            nextOverride.appearance = appearance;
          }
          return {
            readerSettingsByNovel: setNovelOverride(
              state.readerSettingsByNovel,
              novelId,
              nextOverride,
            ),
          };
        }),
      applyTheme: (theme) =>
        set((state) => ({
          appearance: {
            ...state.appearance,
            themeId: theme.id,
            backgroundColor: theme.backgroundColor,
            textColor: theme.textColor,
          },
        })),
      applySourceTheme: (sourceId, theme) =>
        set((state) => {
          const existing = state.readerSettingsBySource[sourceId];
          const appearance = getNextAppearanceOverride(
            state.appearance,
            existing?.appearance,
            {
              themeId: theme.id,
              backgroundColor: theme.backgroundColor,
              textColor: theme.textColor,
            },
          );
          const nextOverride: ReaderSourceSettingsOverride = {
            ...(existing ?? { enabled: true }),
          };
          if (isEmptyRecord(appearance)) {
            delete nextOverride.appearance;
          } else {
            nextOverride.appearance = appearance;
          }
          return {
            readerSettingsBySource: setSourceOverride(
              state.readerSettingsBySource,
              sourceId,
              nextOverride,
            ),
          };
        }),
      applyNovelTheme: (novelId, theme, baseAppearance) =>
        set((state) => {
          const existing = state.readerSettingsByNovel[novelId];
          const appearance = getNextAppearanceOverride(
            baseAppearance ?? state.appearance,
            existing?.appearance,
            {
              themeId: theme.id,
              backgroundColor: theme.backgroundColor,
              textColor: theme.textColor,
            },
          );
          const nextOverride: ReaderNovelSettingsOverride = {
            ...(existing ?? { enabled: true }),
          };
          if (isEmptyRecord(appearance)) {
            delete nextOverride.appearance;
          } else {
            nextOverride.appearance = appearance;
          }
          return {
            readerSettingsByNovel: setNovelOverride(
              state.readerSettingsByNovel,
              novelId,
              nextOverride,
            ),
          };
        }),
      saveCustomTheme: (theme) =>
        set((state) => {
          const customThemes = state.appearance.customThemes.filter(
            (entry) => entry.id !== theme.id,
          );
          customThemes.push(theme);
          return {
            appearance: {
              ...state.appearance,
              customThemes,
            },
          };
        }),
      deleteCustomTheme: (themeId) =>
        set((state) => ({
          appearance: {
            ...state.appearance,
            customThemes: state.appearance.customThemes.filter(
              (theme) => theme.id !== themeId,
            ),
          },
        })),
      applyTapZonePreset: (presetId) =>
        set((state) => {
          const preset = getTapZonePreset(presetId);
          return {
            general: {
              ...state.general,
              tapZonePresetId: preset.id,
              tapZones: normalizeTapZones(preset.zones, TAP_ZONE_DEFAULTS),
            },
          };
        }),
      setLastReadChapter: (novelId, chapterId) =>
        set((state) => ({
          lastReadChapterByNovel: {
            ...state.lastReadChapterByNovel,
            [novelId]: chapterId,
          },
        })),
      applySharedResume: ({ novelId, chapterId, anchor }) => {
        if (!Number.isSafeInteger(novelId) || novelId <= 0 ||
            (chapterId !== null && (!Number.isSafeInteger(chapterId) || chapterId <= 0))) {
          throw new Error("Shared reading position has an invalid local identity.");
        }
        const portable = anchor && chapterId !== null ? getPortableReaderAnchor({ ...anchor, novelId }) : null;
        const checked = portable ? { ...portable, novelId } : undefined;
        applySharedReaderState(() => {
          set((state) => {
            const lastReadChapterByNovel = { ...state.lastReadChapterByNovel };
            const novelPageIndexByNovel = { ...state.novelPageIndexByNovel };
            const chapterScrollAnchors = { ...state.chapterScrollAnchors };
            delete novelPageIndexByNovel[novelId];
            if (chapterId === null) {
              delete lastReadChapterByNovel[novelId];
              for (const [id, value] of Object.entries(chapterScrollAnchors)) {
                if (value.novelId === novelId) delete chapterScrollAnchors[Number(id)];
              }
            } else {
              lastReadChapterByNovel[novelId] = chapterId;
              if (checked) chapterScrollAnchors[chapterId] = checked;
              else delete chapterScrollAnchors[chapterId];
            }
            return {
              lastReadChapterByNovel,
              novelPageIndexByNovel,
              chapterScrollAnchors: limitChapterScrollAnchors(chapterScrollAnchors),
            };
          });
        });
      },
      setNovelPageIndex: (novelId, pageIndex) =>
        set((state) => ({
          novelPageIndexByNovel: {
            ...state.novelPageIndexByNovel,
            [novelId]: Math.max(1, Math.round(pageIndex)),
          },
        })),
      setChapterScrollAnchor: (chapterId, anchor) =>
        set((state) => {
          if (!anchor) {
            if (!(chapterId in state.chapterScrollAnchors)) return state;
            const { [chapterId]: _removed, ...chapterScrollAnchors } =
              state.chapterScrollAnchors;
            return { chapterScrollAnchors };
          }
          return {
            chapterScrollAnchors: limitChapterScrollAnchors({
              ...state.chapterScrollAnchors,
              [chapterId]: { ...anchor, savedAt: Date.now() },
            }),
          };
        }),
      mergeNovelReaderState: ({
        chapterIdMap,
        preferredLastReadChapterId,
        sourceNovelId,
        targetNovelId,
      }) =>
        set((state) => {
          if (sourceNovelId === targetNovelId) return state;

          const {
            [sourceNovelId]: sourceLastReadChapterId,
            ...lastReadChapterByNovel
          } = state.lastReadChapterByNovel;
          const {
            [sourceNovelId]: sourcePageIndex,
            ...novelPageIndexByNovel
          } = state.novelPageIndexByNovel;
          const {
            [sourceNovelId]: sourceReaderSettings,
            ...readerSettingsByNovel
          } = state.readerSettingsByNovel;
          const chapterScrollAnchors: Record<number, ReaderChapterScrollAnchor> =
            {};
          for (const [chapterId, anchor] of Object.entries(
            state.chapterScrollAnchors,
          )) {
            if (anchor.novelId !== sourceNovelId) {
              chapterScrollAnchors[Number(chapterId)] = anchor;
              continue;
            }
            const targetChapterId = chapterIdMap[Number(chapterId)];
            if (targetChapterId === undefined) continue;
            chapterScrollAnchors[targetChapterId] ??= {
              ...anchor,
              novelId: targetNovelId,
            };
          }

          const mappedSourceLastReadChapterId = sourceLastReadChapterId
            ? chapterIdMap[sourceLastReadChapterId]
            : undefined;
          const nextLastReadChapterId =
            preferredLastReadChapterId ??
            lastReadChapterByNovel[targetNovelId] ??
            mappedSourceLastReadChapterId;
          if (nextLastReadChapterId) {
            lastReadChapterByNovel[targetNovelId] = nextLastReadChapterId;
          }
          if (
            novelPageIndexByNovel[targetNovelId] === undefined &&
            mappedSourceLastReadChapterId !== undefined &&
            sourcePageIndex !== undefined
          ) {
            novelPageIndexByNovel[targetNovelId] = sourcePageIndex;
          }
          if (
            readerSettingsByNovel[targetNovelId] === undefined &&
            sourceReaderSettings !== undefined
          ) {
            readerSettingsByNovel[targetNovelId] = sourceReaderSettings;
          }

          return {
            chapterScrollAnchors,
            lastReadChapterByNovel,
            novelPageIndexByNovel,
            readerSettingsByNovel,
          };
        }),
      removeNovelReaderState: (novelId) =>
        set((state) => {
          const { [novelId]: _chapter, ...lastReadChapterByNovel } = state.lastReadChapterByNovel;
          const { [novelId]: _page, ...novelPageIndexByNovel } = state.novelPageIndexByNovel;
          const { [novelId]: _settings, ...readerSettingsByNovel } = state.readerSettingsByNovel;
          const chapterScrollAnchors = Object.fromEntries(
            Object.entries(state.chapterScrollAnchors).filter(
              ([, anchor]) => anchor.novelId !== novelId,
            ),
          );
          return {
            chapterScrollAnchors,
            lastReadChapterByNovel,
            novelPageIndexByNovel,
            readerSettingsByNovel,
          };
        }),
      resetReadingProgress: () =>
        set({
          chapterScrollAnchors: {},
          lastReadChapterByNovel: {},
          novelPageIndexByNovel: {},
        }),
      resetSourceReaderSettings: (sourceId) =>
        set((state) => {
          const { [sourceId]: _removed, ...readerSettingsBySource } =
            state.readerSettingsBySource;
          return { readerSettingsBySource };
        }),
      resetNovelReaderSettings: (novelId) =>
        set((state) => {
          const { [novelId]: _removed, ...readerSettingsByNovel } =
            state.readerSettingsByNovel;
          return { readerSettingsByNovel };
        }),
      resetReaderSettings: (options) =>
        set({
          general: READER_GENERAL_DEFAULTS,
          appearance: READER_APPEARANCE_DEFAULTS,
          ...(options?.keepScopedSettings
            ? {}
            : { readerSettingsByNovel: {}, readerSettingsBySource: {} }),
        }),
    }),
    {
      name: "reader-settings",
      merge: (persistedState, currentState) => {
        if (persistedState === null || typeof persistedState !== "object") {
          return currentState;
        }
        const persisted = persistedState as Partial<ReaderState>;
        const tapZonePresetId = normalizeTapZonePresetId(
          persisted.general?.tapZonePresetId,
        );
        const tapZonePreset = getTapZonePreset(tapZonePresetId);
        const persistedGeneral = { ...(persisted.general ?? {}) } as Partial<
          ReaderGeneralSettings
        >;
        const general = {
          ...READER_GENERAL_DEFAULTS,
          ...persistedGeneral,
          tapZonePresetId,
          tapZones: normalizeTapZones(
            persistedGeneral.tapZones ?? tapZonePreset.zones,
            tapZonePreset.zones,
          ),
        };
        if (!general.pageReader) {
          general.twoPageReader = false;
        }
        general.pdfPageFitMode = normalizePdfPageFitMode(
          general.pdfPageFitMode,
        );
        general.htmlImagePagingMode = normalizeHtmlImagePagingMode(
          general.htmlImagePagingMode,
        );
        general.pageTransitionDuration = Math.round(
          clamp(
            general.pageTransitionDuration,
            READER_PAGE_TRANSITION_DURATION_MIN_MS,
            READER_PAGE_TRANSITION_DURATION_MAX_MS,
          ),
        );
        const persistedAppearance = isRecord(persisted.appearance)
          ? (persisted.appearance as Partial<ReaderAppearanceSettings>)
          : {};
        const appearance = {
          ...READER_APPEARANCE_DEFAULTS,
          ...normalizeAppearance({
            ...READER_APPEARANCE_DEFAULTS,
            ...persistedAppearance,
          }),
        };

        return {
          ...currentState,
          ...persisted,
          general,
          appearance,
          chapterScrollAnchors: normalizeChapterScrollAnchors(
            persisted.chapterScrollAnchors,
          ),
          readerSettingsByNovel: normalizeReaderSettingsByNovel(
            persisted.readerSettingsByNovel,
          ),
          readerSettingsBySource: normalizeReaderSettingsBySource(
            persisted.readerSettingsBySource,
          ),
        };
      },
      partialize: (state) => ({
        general: state.general,
        appearance: state.appearance,
        lastReadChapterByNovel: state.lastReadChapterByNovel,
        novelPageIndexByNovel: state.novelPageIndexByNovel,
        chapterScrollAnchors: state.chapterScrollAnchors,
        readerSettingsByNovel: state.readerSettingsByNovel,
        readerSettingsBySource: state.readerSettingsBySource,
      }),
    },
  ),
);
