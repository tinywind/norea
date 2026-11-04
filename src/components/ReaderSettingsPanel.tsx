import { useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  ColorInput,
  NumberInput,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  UnstyledButton,
} from "@mantine/core";
import { SegmentedToggle } from "./SegmentedToggle";
import {
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
  SettingsWideField,
} from "./SettingsPrimitives";
import { TextButton } from "./TextButton";
import { ResponsiveSheet, SheetActions } from "./ui/ResponsiveSheet";
import { WarningIcon } from "./ui/icons";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  READER_PAGE_TRANSITION_DURATION_MAX_MS,
  READER_PAGE_TRANSITION_DURATION_MIN_MS,
  READER_TAP_PRESETS,
  READER_TAP_ZONES,
  READER_CUSTOM_CSS_PRESETS,
  READER_FONT_OPTIONS,
  READER_PRESET_THEMES,
  getEffectiveReaderAppearanceSettings,
  getEffectiveReaderGeneralSettings,
  useReaderStore,
  type ReaderAppearanceSettings,
  type ReaderCustomCssPresetId,
  type ReaderGeneralSettings,
  type ReaderHtmlImagePagingMode,
  type ReaderPdfPageFitMode,
  type ReaderSettingsOverride,
  type ReaderTapAction,
  type ReaderTapPreset,
  type ReaderTapPresetId,
} from "../store/reader";
import "../styles/settings.css";

const TAP_ACTION_LABEL_KEYS: Record<ReaderTapAction, TranslationKey> = {
  none: "readerSettings.tapAction.none",
  previous: "readerSettings.tapAction.previous",
  menu: "readerSettings.tapAction.menu",
  next: "readerSettings.tapAction.next",
};

const TAP_PRESET_LABEL_KEYS: Record<ReaderTapPresetId, TranslationKey> = {
  balanced: "readerSettings.tapPreset.balanced",
  "side-columns": "readerSettings.tapPreset.sideColumns",
  "vertical-scroll": "readerSettings.tapPreset.verticalScroll",
  "bottom-forward-wide": "readerSettings.tapPreset.bottomForwardWide",
  "top-center-previous": "readerSettings.tapPreset.topCenterPrevious",
};

const READER_THEME_LABEL_KEYS: Record<string, TranslationKey> = {
  paper: "readerSettings.theme.paper",
  sepia: "readerSettings.theme.sepia",
  sage: "readerSettings.theme.sage",
  dark: "readerSettings.theme.dark",
  amoled: "readerSettings.theme.amoled",
};

const CUSTOM_CSS_PRESET_LABEL_KEYS: Record<
  ReaderCustomCssPresetId,
  TranslationKey
> = {
  webtoon: "readerSettings.customCssPreset.webtoon",
  "webtoon-spaced": "readerSettings.customCssPreset.webtoonSpaced",
  "comic-spread": "readerSettings.customCssPreset.comicSpread",
  "comic-page": "readerSettings.customCssPreset.comicPage",
  "page-fit-media": "readerSettings.customCssPreset.pageFitMedia",
};

type ReaderModeOption = "scroll" | "paged" | "two-page";
type ReaderCustomCssPresetSelectValue =
  | ReaderCustomCssPresetId
  | "custom"
  | "none";

export type ReaderSettingsPanelTarget =
  | { kind: "global"; label?: string }
  | { kind: "source"; sourceId: string; label?: string }
  | {
      kind: "novel";
      novelId: number;
      sourceId?: string | null;
      sourceLabel?: string | null;
      label?: string;
    };

interface ReaderSettingsEditorOptions {
  target?: ReaderSettingsPanelTarget;
  novelId?: number | null;
  /**
   * For a novel target, edit the scope the reader currently applies and show
   * a scope switch instead of the override toggle.
   */
  editEffectiveScope?: boolean;
}

/** What the open chapter needs, so settings that cannot apply stay hidden. */
export interface ReaderSettingsContentContext {
  kind: "html" | "pdf";
  hasImages: boolean;
}

type ReaderNovelSettingsPanelTarget = Extract<
  ReaderSettingsPanelTarget,
  { kind: "novel" }
>;

export type ReaderSettingsScopeKind = ReaderSettingsPanelTarget["kind"];

function getScopeTarget(
  target: ReaderNovelSettingsPanelTarget,
  scope: ReaderSettingsScopeKind,
): ReaderSettingsPanelTarget {
  if (scope === "novel") return target;
  if (scope === "source" && target.sourceId) {
    return {
      kind: "source",
      sourceId: target.sourceId,
      label: target.sourceLabel ?? undefined,
    };
  }
  return { kind: "global" };
}

function isScopeOn(
  scope: ReaderSettingsScopeKind,
  novelOverride: ReaderSettingsOverride | undefined,
  sourceOverride: ReaderSettingsOverride | undefined,
): boolean {
  if (scope === "novel") return Boolean(novelOverride?.enabled);
  if (scope === "source") return Boolean(sourceOverride?.enabled);
  return true;
}

function getEffectiveReaderSettingsTarget(
  target: ReaderNovelSettingsPanelTarget,
  novelOverride: ReaderSettingsOverride | undefined,
  sourceOverride: ReaderSettingsOverride | undefined,
): ReaderSettingsPanelTarget {
  if (novelOverride?.enabled) return target;
  if (target.sourceId && sourceOverride?.enabled) {
    return {
      kind: "source",
      sourceId: target.sourceId,
      label: target.sourceLabel ?? undefined,
    };
  }
  return { kind: "global" };
}

const PDF_PAGE_FIT_OPTIONS: Array<{
  value: ReaderPdfPageFitMode;
  labelKey: TranslationKey;
}> = [
  { value: "width", labelKey: "readerSettings.pdfPageFitMode.width" },
  { value: "height", labelKey: "readerSettings.pdfPageFitMode.height" },
  { value: "contain", labelKey: "readerSettings.pdfPageFitMode.contain" },
];

const HTML_IMAGE_PAGING_OPTIONS: Array<{
  value: ReaderHtmlImagePagingMode;
  labelKey: TranslationKey;
}> = [
  { value: "auto", labelKey: "readerSettings.htmlImagePagingMode.auto" },
  {
    value: "next-page",
    labelKey: "readerSettings.htmlImagePagingMode.nextPage",
  },
  {
    value: "single-image",
    labelKey: "readerSettings.htmlImagePagingMode.singleImage",
  },
  {
    value: "fragment",
    labelKey: "readerSettings.htmlImagePagingMode.fragment",
  },
];

function getReaderGeneralSettingsForEditor(
  base: ReaderGeneralSettings,
  override: ReaderSettingsOverride | undefined,
): ReaderGeneralSettings {
  return {
    ...base,
    ...(override?.general ?? {}),
  };
}

function getReaderAppearanceSettingsForEditor(
  base: ReaderAppearanceSettings,
  override: ReaderSettingsOverride | undefined,
): ReaderAppearanceSettings {
  return {
    ...base,
    ...(override?.appearance ?? {}),
    customThemes: base.customThemes,
  };
}

export function useReaderSettingsEditor({
  target,
  novelId = null,
  editEffectiveScope = false,
}: ReaderSettingsEditorOptions = {}) {
  const { t } = useTranslation();
  const legacyNovelId =
    typeof novelId === "number" && novelId > 0 ? novelId : null;
  const requestedTarget: ReaderSettingsPanelTarget =
    target ??
    (legacyNovelId
      ? { kind: "novel", novelId: legacyNovelId }
      : { kind: "global" });
  const effectiveScopeTarget =
    editEffectiveScope &&
    requestedTarget.kind === "novel" &&
    requestedTarget.novelId > 0
      ? requestedTarget
      : null;
  const readerNovelOverride = useReaderStore((state) =>
    effectiveScopeTarget
      ? state.readerSettingsByNovel[effectiveScopeTarget.novelId]
      : undefined,
  );
  const readerSourceOverride = useReaderStore((state) =>
    effectiveScopeTarget?.sourceId
      ? state.readerSettingsBySource[effectiveScopeTarget.sourceId]
      : undefined,
  );
  const [chosenScope, setChosenScope] =
    useState<ReaderSettingsScopeKind | null>(null);
  const resolvedTarget = effectiveScopeTarget
    ? chosenScope &&
      isScopeOn(chosenScope, readerNovelOverride, readerSourceOverride)
      ? getScopeTarget(effectiveScopeTarget, chosenScope)
      : getEffectiveReaderSettingsTarget(
          effectiveScopeTarget,
          readerNovelOverride,
          readerSourceOverride,
        )
    : requestedTarget;
  const targetKind = resolvedTarget.kind;
  const scopedSourceId =
    targetKind === "source"
      ? resolvedTarget.sourceId
      : targetKind === "novel"
        ? (resolvedTarget.sourceId ?? null)
        : null;
  const scopedNovelId =
    targetKind === "novel" && resolvedTarget.novelId > 0
      ? resolvedTarget.novelId
      : null;
  const globalGeneral = useReaderStore((state) => state.general);
  const globalAppearance = useReaderStore((state) => state.appearance);
  const sourceSettingsOverride = useReaderStore((state) =>
    scopedSourceId ? state.readerSettingsBySource[scopedSourceId] : undefined,
  );
  const novelSettingsOverride = useReaderStore((state) =>
    scopedNovelId ? state.readerSettingsByNovel[scopedNovelId] : undefined,
  );
  const setGeneral = useReaderStore((state) => state.setGeneral);
  const setAppearance = useReaderStore((state) => state.setAppearance);
  const setSourceReaderSettingsEnabled = useReaderStore(
    (state) => state.setSourceReaderSettingsEnabled,
  );
  const setSourceGeneral = useReaderStore((state) => state.setSourceGeneral);
  const setSourceAppearance = useReaderStore(
    (state) => state.setSourceAppearance,
  );
  const setNovelReaderSettingsEnabled = useReaderStore(
    (state) => state.setNovelReaderSettingsEnabled,
  );
  const startSourceReaderSettings = useReaderStore(
    (state) => state.startSourceReaderSettings,
  );
  const startNovelReaderSettings = useReaderStore(
    (state) => state.startNovelReaderSettings,
  );
  const copyReaderSettingsToGlobal = useReaderStore(
    (state) => state.copyReaderSettingsToGlobal,
  );
  const setNovelGeneral = useReaderStore((state) => state.setNovelGeneral);
  const setNovelAppearance = useReaderStore(
    (state) => state.setNovelAppearance,
  );
  const applyTheme = useReaderStore((state) => state.applyTheme);
  const applySourceTheme = useReaderStore((state) => state.applySourceTheme);
  const applyNovelTheme = useReaderStore((state) => state.applyNovelTheme);
  const saveCustomTheme = useReaderStore((state) => state.saveCustomTheme);
  const resetReaderSettings = useReaderStore(
    (state) => state.resetReaderSettings,
  );
  const resetSourceReaderSettings = useReaderStore(
    (state) => state.resetSourceReaderSettings,
  );
  const resetNovelReaderSettings = useReaderStore(
    (state) => state.resetNovelReaderSettings,
  );
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [keepScopedSettings, setKeepScopedSettings] = useState(true);
  const closeResetConfirmation = () => setResetConfirmOpen(false);
  const targetOverride =
    targetKind === "source" ? sourceSettingsOverride : novelSettingsOverride;
  const sourceSettingsEnabled = Boolean(sourceSettingsOverride?.enabled);
  const novelSettingsEnabled = Boolean(novelSettingsOverride?.enabled);
  const targetSettingsEnabled =
    targetKind === "global" ||
    (targetKind === "source"
      ? sourceSettingsEnabled
      : novelSettingsEnabled);
  const settingsLocked = targetKind !== "global" && !targetSettingsEnabled;
  const baseGeneral = useMemo(
    () =>
      targetKind === "novel"
        ? getEffectiveReaderGeneralSettings(
            globalGeneral,
            sourceSettingsOverride,
          )
        : globalGeneral,
    [globalGeneral, sourceSettingsOverride, targetKind],
  );
  const baseAppearance = useMemo(
    () =>
      targetKind === "novel"
        ? getEffectiveReaderAppearanceSettings(
            globalAppearance,
            sourceSettingsOverride,
          )
        : globalAppearance,
    [globalAppearance, sourceSettingsOverride, targetKind],
  );
  const general = useMemo(
    () =>
      targetKind === "global"
        ? globalGeneral
        : getReaderGeneralSettingsForEditor(baseGeneral, targetOverride),
    [baseGeneral, globalGeneral, targetKind, targetOverride],
  );
  const appearance = useMemo(
    () =>
      targetKind === "global"
        ? globalAppearance
        : getReaderAppearanceSettingsForEditor(baseAppearance, targetOverride),
    [baseAppearance, globalAppearance, targetKind, targetOverride],
  );
  const scopeDisplayName =
    resolvedTarget.label?.trim() ||
    (targetKind === "source"
      ? (scopedSourceId ?? t("readerSettings.scope.sourceFallback"))
      : targetKind === "novel"
        ? t("readerSettings.scope.novelFallback")
        : t("readerSettings.scope.globalName"));
  const resolvedSourceLabel =
    targetKind === "novel" ? resolvedTarget.sourceLabel?.trim() : "";
  const fallbackSourceDisplayName =
    resolvedSourceLabel ||
    scopedSourceId ||
    t("readerSettings.scope.sourceFallback");
  const sourceDisplayName =
    targetKind === "source"
      ? scopeDisplayName
      : targetKind === "novel"
        ? fallbackSourceDisplayName
        : t("readerSettings.scope.globalName");
  const scopeTitle =
    targetKind === "source"
      ? t("readerSettings.scope.sourceTitle", { name: scopeDisplayName })
      : targetKind === "novel"
        ? t("readerSettings.scope.novelTitle", { name: scopeDisplayName })
        : t("readerSettings.scope.globalTitle");
  const scopeDescription =
    targetKind === "source"
      ? t("readerSettings.scope.sourceDescription")
      : targetKind === "novel"
        ? t("readerSettings.scope.novelDescription")
        : t("readerSettings.scope.globalDescription");
  const scopeBadge =
    targetKind === "global"
      ? t("readerSettings.scope.globalBadge")
      : targetSettingsEnabled
        ? t("readerSettings.scope.activeBadge")
        : t("readerSettings.scope.inactiveBadge");
  const appliedScopeLabel =
    targetKind === "novel" && novelSettingsEnabled
      ? t("readerSettings.scope.appliedNovel", { name: scopeDisplayName })
      : scopedSourceId && sourceSettingsEnabled
        ? t("readerSettings.scope.appliedSource", {
            name: sourceDisplayName,
          })
        : t("readerSettings.scope.appliedGlobal");

  const readerThemes = useMemo(
    () => [...READER_PRESET_THEMES, ...appearance.customThemes],
    [appearance.customThemes],
  );
  const readerMode: ReaderModeOption = general.pageReader
    ? general.twoPageReader
      ? "two-page"
      : "paged"
    : "scroll";
  const customCssPresetValue = getCustomCssPresetValue(
    appearance.customCss,
    general,
  );
  const customCssPresetOptions = useMemo(
    () => [
      {
        value: "none",
        label: t("readerSettings.customCssPreset.none"),
      },
      ...READER_CUSTOM_CSS_PRESETS.map((preset) => ({
        value: preset.id,
        label: t(CUSTOM_CSS_PRESET_LABEL_KEYS[preset.id]),
      })),
      ...(customCssPresetValue === "custom"
        ? [
            {
              value: "custom",
              label: t("readerSettings.customCssPreset.custom"),
            },
          ]
        : []),
    ],
    [customCssPresetValue, t],
  );

  function handleSaveCustomTheme(): void {
    if (settingsLocked) return;

    const id = `custom-${Date.now()}`;
    saveCustomTheme({
      id,
      label: t("readerSettings.customThemeName", {
        number: appearance.customThemes.length + 1,
      }),
      backgroundColor: appearance.backgroundColor,
      textColor: appearance.textColor,
    });
    setActiveAppearance({ themeId: id });
  }

  function setActiveGeneral(settings: Partial<ReaderGeneralSettings>): void {
    if (settingsLocked) return;

    if (targetKind === "source") {
      if (scopedSourceId) setSourceGeneral(scopedSourceId, settings);
      return;
    }
    if (targetKind === "novel") {
      if (scopedNovelId !== null) {
        setNovelGeneral(scopedNovelId, settings, baseGeneral);
      }
      return;
    }
    setGeneral(settings);
  }

  function setActiveAppearance(
    settings: Partial<ReaderAppearanceSettings>,
  ): void {
    if (settingsLocked) return;

    if (targetKind === "source") {
      if (scopedSourceId) setSourceAppearance(scopedSourceId, settings);
      return;
    }
    if (targetKind === "novel") {
      if (scopedNovelId !== null) {
        setNovelAppearance(scopedNovelId, settings, baseAppearance);
      }
      return;
    }
    setAppearance(settings);
  }

  function applyActiveTheme(theme: Parameters<typeof applyTheme>[0]): void {
    if (settingsLocked) return;

    if (targetKind === "source") {
      if (scopedSourceId) applySourceTheme(scopedSourceId, theme);
      return;
    }
    if (targetKind === "novel") {
      if (scopedNovelId !== null) {
        applyNovelTheme(scopedNovelId, theme, baseAppearance);
      }
      return;
    }
    applyTheme(theme);
  }

  function openResetConfirmation(): void {
    if (settingsLocked) return;

    setKeepScopedSettings(true);
    setResetConfirmOpen(true);
  }

  function resetActiveReaderSettings(): void {
    setResetConfirmOpen(false);
    if (settingsLocked) return;

    if (targetKind === "source") {
      if (scopedSourceId) resetSourceReaderSettings(scopedSourceId);
      return;
    }
    if (targetKind === "novel") {
      if (scopedNovelId !== null) {
        resetNovelReaderSettings(scopedNovelId);
      }
      return;
    }
    resetReaderSettings({ keepScopedSettings });
  }

  function handleTargetSettingsEnabledChange(enabled: boolean): void {
    if (targetKind === "source") {
      if (scopedSourceId) {
        setSourceReaderSettingsEnabled(scopedSourceId, enabled);
      }
      return;
    }
    if (targetKind === "novel" && scopedNovelId !== null) {
      setNovelReaderSettingsEnabled(scopedNovelId, enabled);
    }
  }

  /** Edits another scope; a source or novel scope is turned on first. */
  function selectEditScope(scope: ReaderSettingsScopeKind): void {
    if (!effectiveScopeTarget) return;
    if (scope === "novel") {
      startNovelReaderSettings(effectiveScopeTarget.novelId);
    } else if (scope === "source") {
      if (!effectiveScopeTarget.sourceId) return;
      startSourceReaderSettings(effectiveScopeTarget.sourceId);
    }
    setChosenScope(scope);
  }

  /** Turns the edited override off, so the reader uses what it inherits. */
  function inheritScopeSettings(): void {
    handleTargetSettingsEnabledChange(false);
    setChosenScope(null);
  }

  function copyScopeSettingsToGlobal(): void {
    if (targetKind === "source" && scopedSourceId) {
      copyReaderSettingsToGlobal({ kind: "source", sourceId: scopedSourceId });
    } else if (targetKind === "novel" && scopedNovelId !== null) {
      copyReaderSettingsToGlobal({
        kind: "novel",
        novelId: scopedNovelId,
        sourceId: scopedSourceId,
      });
    } else {
      return;
    }
    setChosenScope(null);
  }

  const overridingScope: "source" | "novel" | null = !effectiveScopeTarget
    ? null
    : targetKind !== "novel" && readerNovelOverride?.enabled
      ? "novel"
      : targetKind === "global" && readerSourceOverride?.enabled
        ? "source"
        : null;

  function handleApplyTapZonePreset(presetId: ReaderTapPresetId): void {
    const preset = READER_TAP_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) return;
    setActiveGeneral({
      tapZonePresetId: preset.id,
      tapZones: preset.zones,
    });
  }

  function handleCustomCssPresetChange(presetValue: string | null): void {
    if (!presetValue || presetValue === "custom") return;
    if (presetValue === "none") {
      setActiveAppearance({ customCss: "" });
      return;
    }
    const preset = READER_CUSTOM_CSS_PRESETS.find(
      (entry) => entry.id === presetValue,
    );
    if (preset) {
      if (preset.general) {
        setActiveGeneral(preset.general);
      }
      setActiveAppearance({
        ...(preset.appearance ?? {}),
        customCss: preset.css,
      });
    }
  }

  function setReaderMode(value: string): void {
    switch (value) {
      case "two-page":
        setActiveGeneral({
          autoScroll: false,
          pageReader: true,
          twoPageReader: true,
        });
        break;
      case "paged":
        setActiveGeneral({
          autoScroll: false,
          pageReader: true,
          twoPageReader: false,
        });
        break;
      default:
        setActiveGeneral({
          pageReader: false,
          twoPageReader: false,
        });
        break;
    }
  }

  return {
    t,
    appearance,
    appliedScopeLabel,
    closeResetConfirmation,
    customCssPresetOptions,
    customCssPresetValue,
    effectiveScopeTarget,
    general,
    keepScopedSettings,
    overridingScope,
    readerMode,
    readerThemes,
    resetConfirmOpen,
    scopeBadge,
    scopeDescription,
    scopeDisplayName,
    scopeTitle,
    settingsLocked,
    targetKind,
    targetSettingsEnabled,
    applyActiveTheme,
    copyScopeSettingsToGlobal,
    handleApplyTapZonePreset,
    handleCustomCssPresetChange,
    handleSaveCustomTheme,
    handleTargetSettingsEnabledChange,
    inheritScopeSettings,
    openResetConfirmation,
    resetActiveReaderSettings,
    selectEditScope,
    setActiveAppearance,
    setActiveGeneral,
    setKeepScopedSettings,
    setReaderMode,
  };
}

export type ReaderSettingsEditor = ReturnType<typeof useReaderSettingsEditor>;

/**
 * Builds every reader settings field once, so the full settings panel and the
 * reader's quick settings place the same controls without duplicating them.
 */
export function buildReaderSettingsFields(editor: ReaderSettingsEditor) {
  const {
    t,
    appearance,
    effectiveScopeTarget,
    general,
    setActiveAppearance,
    setActiveGeneral,
    targetKind,
  } = editor;

  return {
    scope: (
      <div
        className="norea-reader-settings-scope-card"
        data-enabled={editor.targetSettingsEnabled}
        data-scope={targetKind}
      >
        <div className="norea-reader-settings-scope-main">
          <span className="norea-reader-settings-scope-title">
            {editor.scopeTitle}
          </span>
          <span className="norea-reader-settings-scope-description">
            {editor.scopeDescription}
          </span>
        </div>
        <span className="norea-reader-settings-scope-badge">
          {editor.scopeBadge}
        </span>
      </div>
    ),
    scopeToggle:
      targetKind !== "global" && !effectiveScopeTarget ? (
        <SettingsSection title={t("readerSettings.scope.title")}>
          <SettingsFieldRow
            label={t(
              targetKind === "source"
                ? "readerSettings.sourceScope"
                : "readerSettings.novelScope",
            )}
            description={t(
              targetKind === "source"
                ? "readerSettings.sourceScope.description"
                : "readerSettings.novelScope.description",
            )}
          >
            <Switch
              checked={editor.targetSettingsEnabled}
              onChange={(event) =>
                editor.handleTargetSettingsEnabledChange(
                  event.currentTarget.checked,
                )
              }
            />
          </SettingsFieldRow>
        </SettingsSection>
      ) : null,
    lockedNotice: (
      <div className="norea-reader-settings-disabled-notice" role="status">
        <WarningIcon className="norea-reader-settings-disabled-icon" />
        <div className="norea-reader-settings-disabled-copy">
          <span className="norea-reader-settings-disabled-title">
            {t("readerSettings.scope.disabledTitle")}
          </span>
          <span className="norea-reader-settings-disabled-description">
            {t("readerSettings.scope.disabledDescription", {
              scope: editor.appliedScopeLabel,
            })}
          </span>
        </div>
      </div>
    ),
    readingMode: (
      <SettingsFieldRow
        label={t("readerSettings.readingMode")}
        description={t("readerSettings.readingMode.description")}
      >
        <SegmentedToggle
          aria-label={t("readerSettings.readingMode")}
          data={[
            { value: "scroll", label: t("readerSettings.scroll") },
            { value: "paged", label: t("readerSettings.paged") },
            { value: "two-page", label: t("readerSettings.twoPage") },
          ]}
          value={editor.readerMode}
          onChange={editor.setReaderMode}
        />
      </SettingsFieldRow>
    ),
    pageTransition: (
      <SettingSlider
        label={t("readerSettings.pageTransitionDuration")}
        description={t("readerSettings.pageTransitionDuration.description")}
        valueLabel={
          general.pageTransitionDuration === 0
            ? t("readerSettings.pageTransitionDuration.off")
            : t("readerSettings.pageTransitionDuration.value", {
                duration: general.pageTransitionDuration,
              })
        }
        min={READER_PAGE_TRANSITION_DURATION_MIN_MS}
        max={READER_PAGE_TRANSITION_DURATION_MAX_MS}
        step={50}
        value={general.pageTransitionDuration}
        onChange={(pageTransitionDuration) =>
          setActiveGeneral({ pageTransitionDuration })
        }
      />
    ),
    pdfPageFit: (
      <SettingsFieldRow
        label={t("readerSettings.pdfPageFitMode")}
        description={t("readerSettings.pdfPageFitMode.description")}
      >
        <SegmentedToggle
          data={PDF_PAGE_FIT_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
          value={general.pdfPageFitMode}
          onChange={(pdfPageFitMode) =>
            setActiveGeneral({
              pdfPageFitMode: pdfPageFitMode as ReaderPdfPageFitMode,
            })
          }
        />
      </SettingsFieldRow>
    ),
    htmlImagePaging: (
      <SettingsFieldRow
        label={t("readerSettings.htmlImagePagingMode")}
        description={t("readerSettings.htmlImagePagingMode.description")}
      >
        <SegmentedToggle
          data={HTML_IMAGE_PAGING_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
          value={general.htmlImagePagingMode}
          onChange={(htmlImagePagingMode) =>
            setActiveGeneral({
              htmlImagePagingMode:
                htmlImagePagingMode as ReaderHtmlImagePagingMode,
            })
          }
        />
      </SettingsFieldRow>
    ),
    fullPageReader: (
      <SettingsFieldRow
        label={t("readerSettings.fullPageReader")}
        description={t("readerSettings.fullPageReader.description")}
      >
        <Switch
          checked={general.fullPageReader}
          onChange={(event) =>
            setActiveGeneral({
              fullPageReader: event.currentTarget.checked,
            })
          }
        />
      </SettingsFieldRow>
    ),
    keepScreenOn: (
      <SettingsFieldRow
        label={t("readerSettings.keepScreenOn")}
        description={t("readerSettings.keepScreenOn.description")}
      >
        <Switch
          checked={general.keepScreenOn}
          onChange={(event) =>
            setActiveGeneral({ keepScreenOn: event.currentTarget.checked })
          }
        />
      </SettingsFieldRow>
    ),
    autoScroll: (
      <>
        <SettingsFieldRow
          label={t("readerSettings.autoScroll")}
          description={t("readerSettings.autoScroll.description")}
        >
          <Switch
            checked={!general.pageReader && general.autoScroll}
            disabled={general.pageReader}
            onChange={(event) =>
              setActiveGeneral({ autoScroll: event.currentTarget.checked })
            }
          />
        </SettingsFieldRow>
        {!general.pageReader && general.autoScroll ? (
          <>
            <SettingsFieldRow
              label={t("readerSettings.autoScrollInterval")}
              description={t("readerSettings.autoScrollInterval.description")}
            >
              <NumberInput
                aria-label={t("readerSettings.autoScrollInterval")}
                value={general.autoScrollInterval}
                min={16}
                max={500}
                rightSection={t("readerSettings.unit.milliseconds")}
                onChange={(value) => {
                  if (typeof value === "number") {
                    setActiveGeneral({ autoScrollInterval: value });
                  }
                }}
              />
            </SettingsFieldRow>
            <SettingsFieldRow
              label={t("readerSettings.autoScrollOffset")}
              description={t("readerSettings.autoScrollOffset.description")}
            >
              <NumberInput
                aria-label={t("readerSettings.autoScrollOffset")}
                value={general.autoScrollOffset}
                min={0.25}
                max={12}
                step={0.25}
                rightSection={t("readerSettings.unit.pixels")}
                onChange={(value) => {
                  if (typeof value === "number") {
                    setActiveGeneral({ autoScrollOffset: value });
                  }
                }}
              />
            </SettingsFieldRow>
          </>
        ) : null}
      </>
    ),
    readerTheme: (
      <SettingsFieldRow
        label={t("readerSettings.readerTheme")}
        description={t("readerSettings.readerTheme.description")}
      >
        <Select
          data={editor.readerThemes.map((theme) => ({
            value: theme.id,
            label: getReaderThemeLabel(theme.id, theme.label, t),
          }))}
          value={appearance.themeId}
          onChange={(themeId) => {
            const nextTheme = editor.readerThemes.find(
              (theme) => theme.id === themeId,
            );
            if (nextTheme) editor.applyActiveTheme(nextTheme);
          }}
        />
      </SettingsFieldRow>
    ),
    backgroundColor: (
      <SettingsFieldRow
        label={t("readerSettings.background")}
        description={t("readerSettings.background.description")}
      >
        <ColorInput
          value={appearance.backgroundColor}
          onChange={(backgroundColor) =>
            setActiveAppearance({ backgroundColor })
          }
        />
      </SettingsFieldRow>
    ),
    textColor: (
      <SettingsFieldRow
        label={t("readerSettings.textColor")}
        description={t("readerSettings.textColor.description")}
      >
        <ColorInput
          value={appearance.textColor}
          onChange={(textColor) => setActiveAppearance({ textColor })}
        />
      </SettingsFieldRow>
    ),
    textSize: (
      <SettingSlider
        label={t("readerSettings.textSize")}
        description={t("readerSettings.textSize.description")}
        valueLabel={`${appearance.textSize}px`}
        min={12}
        max={36}
        step={1}
        value={appearance.textSize}
        onChange={(textSize) => setActiveAppearance({ textSize })}
      />
    ),
    lineHeight: (
      <SettingSlider
        label={t("readerSettings.lineHeight")}
        description={t("readerSettings.lineHeight.description")}
        valueLabel={appearance.lineHeight.toFixed(2)}
        min={1}
        max={2.6}
        step={0.05}
        value={appearance.lineHeight}
        onChange={(lineHeight) => setActiveAppearance({ lineHeight })}
      />
    ),
    padding: (
      <SettingSlider
        label={t("readerSettings.padding")}
        description={t("readerSettings.padding.description")}
        valueLabel={`${appearance.padding}px`}
        min={0}
        max={64}
        step={1}
        value={appearance.padding}
        onChange={(padding) => setActiveAppearance({ padding })}
      />
    ),
    font: (
      <SettingsFieldRow
        label={t("readerSettings.font")}
        description={t("readerSettings.font.description")}
      >
        <Select
          aria-label={t("readerSettings.font")}
          data={READER_FONT_OPTIONS.map((option) => ({
            ...option,
            label:
              option.value === ""
                ? t("readerSettings.font.original")
                : option.label,
          }))}
          value={appearance.fontFamily}
          onChange={(fontFamily) =>
            setActiveAppearance({ fontFamily: fontFamily ?? "" })
          }
        />
      </SettingsFieldRow>
    ),
    alignment: (
      <SettingsFieldRow
        label={t("readerSettings.alignment")}
        description={t("readerSettings.alignment.description")}
      >
        <SegmentedToggle
          aria-label={t("readerSettings.alignment")}
          value={appearance.textAlign}
          onChange={(textAlign) =>
            setActiveAppearance({
              textAlign: textAlign as typeof appearance.textAlign,
            })
          }
          data={[
            { value: "left", label: t("readerSettings.align.left") },
            {
              value: "justify",
              label: t("readerSettings.align.justify"),
            },
            { value: "center", label: t("readerSettings.align.center") },
            { value: "right", label: t("readerSettings.align.right") },
          ]}
        />
      </SettingsFieldRow>
    ),
    themeActions: (
      <SettingsFieldRow
        label={t("readerSettings.actions")}
        description={t("readerSettings.actions.description")}
      >
        <SettingsInlineControls>
          <TextButton variant="default" onClick={editor.handleSaveCustomTheme}>
            {t("readerSettings.saveCustomTheme")}
          </TextButton>
          <TextButton variant="default" onClick={editor.openResetConfirmation}>
            {t("common.reset")}
          </TextButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
    ),
    saveTheme: (
      <SettingsFieldRow>
        <TextButton variant="default" onClick={editor.handleSaveCustomTheme}>
          {t("readerSettings.saveCustomTheme")}
        </TextButton>
      </SettingsFieldRow>
    ),
    reset: (
      <TextButton variant="default" onClick={editor.openResetConfirmation}>
        {t("common.reset")}
      </TextButton>
    ),
    controls: (
      <>
        <SettingsFieldRow
          label={t("readerSettings.swipeGestures")}
          description={t("readerSettings.swipeGestures.description")}
        >
          <Switch
            checked={general.swipeGestures}
            onChange={(event) =>
              setActiveGeneral({ swipeGestures: event.currentTarget.checked })
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("readerSettings.tapControls")}
          description={t("readerSettings.tapControls.description")}
        >
          <Switch
            checked={general.tapToScroll}
            onChange={(event) =>
              setActiveGeneral({ tapToScroll: event.currentTarget.checked })
            }
          />
        </SettingsFieldRow>
        {general.tapToScroll ? (
          <SettingsFieldRow
            label={t("readerSettings.tapPreset")}
            description={t("readerSettings.tapPreset.description")}
            layout="stacked"
          >
            <SettingsWideField>
              <div className="norea-reader-tap-preset-grid">
                {READER_TAP_PRESETS.map((preset) => (
                  <TapZonePresetCard
                    key={preset.id}
                    preset={preset}
                    selected={preset.id === general.tapZonePresetId}
                    onApply={editor.handleApplyTapZonePreset}
                  />
                ))}
              </div>
            </SettingsWideField>
          </SettingsFieldRow>
        ) : null}
      </>
    ),
    indicators: (
      <>
        <SettingsFieldRow
          label={t("readerSettings.seekbar")}
          description={t("readerSettings.seekbar.description")}
        >
          <Switch
            checked={general.showSeekbar}
            onChange={(event) =>
              setActiveGeneral({ showSeekbar: event.currentTarget.checked })
            }
          />
        </SettingsFieldRow>
        {general.showSeekbar ? (
          <SettingsFieldRow
            label={t("readerSettings.verticalSeekbar")}
            description={t("readerSettings.verticalSeekbar.description")}
          >
            <Switch
              checked={general.verticalSeekbar}
              onChange={(event) =>
                setActiveGeneral({
                  verticalSeekbar: event.currentTarget.checked,
                })
              }
            />
          </SettingsFieldRow>
        ) : null}
        <SettingsFieldRow
          label={t("readerSettings.scrollPercentage")}
          description={t("readerSettings.scrollPercentage.description")}
        >
          <Switch
            checked={general.showScrollPercentage}
            onChange={(event) =>
              setActiveGeneral({
                showScrollPercentage: event.currentTarget.checked,
              })
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("readerSettings.batteryTimeFooter")}
          description={t("readerSettings.batteryTimeFooter.description")}
        >
          <Switch
            checked={general.showBatteryAndTime}
            onChange={(event) =>
              setActiveGeneral({
                showBatteryAndTime: event.currentTarget.checked,
              })
            }
          />
        </SettingsFieldRow>
      </>
    ),
    advanced: (
      <>
        <SettingsFieldRow
          label={t("readerSettings.bionicReading")}
          description={t("readerSettings.bionicReading.description")}
        >
          <Switch
            checked={general.bionicReading}
            onChange={(event) =>
              setActiveGeneral({
                bionicReading: event.currentTarget.checked,
              })
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("readerSettings.removeExtraParagraphSpacing")}
          description={t(
            "readerSettings.removeExtraParagraphSpacing.description",
          )}
        >
          <Switch
            checked={general.removeExtraParagraphSpacing}
            onChange={(event) =>
              setActiveGeneral({
                removeExtraParagraphSpacing: event.currentTarget.checked,
              })
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("readerSettings.customCssPreset")}
          description={t("readerSettings.customCssPreset.description")}
        >
          <Select
            data={editor.customCssPresetOptions}
            value={editor.customCssPresetValue}
            onChange={editor.handleCustomCssPresetChange}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("readerSettings.customCss")}
          description={t("readerSettings.customCss.description")}
          layout="stacked"
        >
          <SettingsWideField>
            <Textarea
              value={appearance.customCss}
              autosize
              minRows={5}
              onChange={(event) =>
                setActiveAppearance({
                  customCss: event.currentTarget.value,
                })
              }
            />
          </SettingsWideField>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("readerSettings.customJs")}
          description={t("readerSettings.customJs.description")}
          layout="stacked"
        >
          <SettingsWideField>
            <Textarea
              value={appearance.customJs}
              autosize
              minRows={5}
              onChange={(event) =>
                setActiveAppearance({
                  customJs: event.currentTarget.value,
                })
              }
            />
          </SettingsWideField>
        </SettingsFieldRow>
      </>
    ),
    resetConfirmation: (
      // A sheet rather than useConfirm: the global reset carries the keep-scoped-settings option.
      <ResponsiveSheet
        footer={
          <SheetActions>
            <Button variant="default" onClick={editor.closeResetConfirmation}>
              {t("common.cancel")}
            </Button>
            <Button color="danger" onClick={editor.resetActiveReaderSettings}>
              {t("common.reset")}
            </Button>
          </SheetActions>
        }
        nested
        opened={editor.resetConfirmOpen}
        onClose={editor.closeResetConfirmation}
        size="sm"
        title={t("readerSettings.reset.title")}
      >
        <Stack gap="md">
          <Text size="sm">
            {targetKind === "source"
              ? t("readerSettings.reset.sourceMessage", {
                  name: editor.scopeDisplayName,
                })
              : targetKind === "novel"
                ? t("readerSettings.reset.novelMessage", {
                    name: editor.scopeDisplayName,
                  })
                : t("readerSettings.reset.globalMessage")}
          </Text>
          {targetKind === "global" ? (
            <Checkbox
              checked={editor.keepScopedSettings}
              label={t("readerSettings.reset.keepScopedSettings")}
              onChange={(event) =>
                editor.setKeepScopedSettings(event.currentTarget.checked)
              }
            />
          ) : null}
        </Stack>
      </ResponsiveSheet>
    ),
  };
}

interface ReaderSettingsPanelProps {
  target?: ReaderSettingsPanelTarget;
  novelId?: number | null;
}

/** The full reader settings, grouped in tabs, for settings pages. */
export function ReaderSettingsPanel({
  target,
  novelId = null,
}: ReaderSettingsPanelProps = {}) {
  const editor = useReaderSettingsEditor({ target, novelId });
  const { t } = editor;
  const fields = buildReaderSettingsFields(editor);

  return (
    <Stack gap="md">
      {fields.scope}
      {fields.scopeToggle}
      {editor.settingsLocked ? (
        fields.lockedNotice
      ) : (
        <fieldset className="norea-reader-settings-controls">
          <Tabs
            className="norea-reader-settings-tabs"
            defaultValue="reading"
            keepMounted={false}
          >
            <Tabs.List className="norea-reader-settings-tab-list">
              <Tabs.Tab value="reading">
                {t("readerSettings.reading.title")}
              </Tabs.Tab>
              <Tabs.Tab value="text">{t("readerSettings.text.title")}</Tabs.Tab>
              <Tabs.Tab value="controls">
                {t("readerSettings.controls.title")}
              </Tabs.Tab>
              <Tabs.Tab value="automation">
                {t("readerSettings.automation.title")}
              </Tabs.Tab>
              <Tabs.Tab value="indicators">
                {t("readerSettings.indicators.title")}
              </Tabs.Tab>
              <Tabs.Tab value="advanced">{t("readerSettings.advanced")}</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel
              className="norea-reader-settings-tab-panel"
              value="reading"
            >
              <SettingsSection>
                {fields.readingMode}
                {fields.pageTransition}
                {fields.pdfPageFit}
                {fields.htmlImagePaging}
                {fields.fullPageReader}
                {fields.keepScreenOn}
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel className="norea-reader-settings-tab-panel" value="text">
              <SettingsSection>
                {fields.readerTheme}
                {fields.backgroundColor}
                {fields.textColor}
                {fields.textSize}
                {fields.lineHeight}
                {fields.padding}
                {fields.font}
                {fields.alignment}
                {fields.themeActions}
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel
              className="norea-reader-settings-tab-panel"
              value="controls"
            >
              <SettingsSection>{fields.controls}</SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel
              className="norea-reader-settings-tab-panel"
              value="automation"
            >
              <SettingsSection>
                {fields.autoScroll}
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel
              className="norea-reader-settings-tab-panel"
              value="indicators"
            >
              <SettingsSection>{fields.indicators}</SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel
              className="norea-reader-settings-tab-panel"
              value="advanced"
            >
              <SettingsSection>{fields.advanced}</SettingsSection>
            </Tabs.Panel>
          </Tabs>
        </fieldset>
      )}
      {fields.resetConfirmation}
    </Stack>
  );
}

function getCustomCssPresetValue(
  customCss: string,
  general: ReaderGeneralSettings,
): ReaderCustomCssPresetSelectValue {
  const normalizedCustomCss = customCss.trim();
  if (!normalizedCustomCss) return "none";
  const preset = READER_CUSTOM_CSS_PRESETS.find(
    (entry) =>
      entry.css.trim() === normalizedCustomCss &&
      customCssPresetGeneralMatches(general, entry.general),
  );
  return preset?.id ?? "custom";
}

function customCssPresetGeneralMatches(
  general: ReaderGeneralSettings,
  presetGeneral:
    | {
        htmlImagePagingMode?: ReaderHtmlImagePagingMode;
        pageReader?: boolean;
        twoPageReader?: boolean;
      }
    | undefined,
): boolean {
  if (!presetGeneral) return true;
  return (
    (presetGeneral.pageReader === undefined ||
      presetGeneral.pageReader === general.pageReader) &&
    (presetGeneral.twoPageReader === undefined ||
      presetGeneral.twoPageReader === general.twoPageReader) &&
    (presetGeneral.htmlImagePagingMode === undefined ||
      presetGeneral.htmlImagePagingMode === general.htmlImagePagingMode)
  );
}

function SettingSlider({
  label,
  description,
  valueLabel,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  description: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <SettingsFieldRow label={label} description={description}>
      <div className="norea-settings-slider-control">
        <Text className="norea-settings-slider-value">{valueLabel}</Text>
        <Slider
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={onChange}
        />
      </div>
    </SettingsFieldRow>
  );
}

function TapZonePresetCard({
  preset,
  selected,
  onApply,
}: {
  preset: ReaderTapPreset;
  selected: boolean;
  onApply: (presetId: ReaderTapPresetId) => void;
}) {
  const { t } = useTranslation();

  return (
    <UnstyledButton
      aria-pressed={selected}
      className="norea-reader-tap-preset norea-state-layer"
      data-selected={selected}
      onClick={() => onApply(preset.id)}
      type="button"
    >
      <Text className="norea-reader-tap-preset-name" fw={700} size="sm">
        {t(TAP_PRESET_LABEL_KEYS[preset.id])}
      </Text>
      <TapZonePreview preset={preset} />
    </UnstyledButton>
  );
}

function TapZonePreview({ preset }: { preset: ReaderTapPreset }) {
  const { t } = useTranslation();
  const actions = READER_TAP_ZONES.map((zone) => preset.zones[zone]);

  return (
    <SimpleGrid aria-hidden="true" cols={3} spacing={4}>
      {actions.map((action, index) => (
        <Text
          key={`${preset.id}-${index}`}
          size="xs"
          ta="center"
          fw={600}
          style={{
            border: "1px solid var(--mantine-color-default-border)",
            borderRadius: "0.25rem",
            padding: "0.5rem 0.25rem",
            background: getTapActionBackground(action),
            color: getTapActionColor(action),
          }}
        >
          {t(TAP_ACTION_LABEL_KEYS[action])}
        </Text>
      ))}
    </SimpleGrid>
  );
}

export function getReaderThemeLabel(
  themeId: string,
  fallback: string,
  t: (key: TranslationKey) => string,
): string {
  const key = READER_THEME_LABEL_KEYS[themeId];
  return key ? t(key) : fallback;
}

function getTapActionBackground(action: ReaderTapAction): string {
  switch (action) {
    case "previous":
      return "var(--norea-color-accent-soft)";
    case "next":
      return "var(--norea-color-ok-soft)";
    case "menu":
      return "var(--norea-color-warn-soft)";
    case "none":
      return "var(--norea-color-surface-raised)";
  }
}

function getTapActionColor(action: ReaderTapAction): string {
  switch (action) {
    case "previous":
      return "var(--norea-color-on-accent-soft)";
    case "next":
      return "var(--norea-color-on-ok-soft)";
    case "menu":
      return "var(--norea-color-on-warn-soft)";
    case "none":
      return "var(--norea-color-ink-muted)";
  }
}
