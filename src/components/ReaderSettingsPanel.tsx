import { useMemo } from "react";
import {
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

interface ReaderSettingsPanelProps {
  inlineAutomation?: boolean;
  target?: ReaderSettingsPanelTarget;
  novelId?: number | null;
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

export function ReaderSettingsPanel({
  inlineAutomation = false,
  target,
  novelId = null,
}: ReaderSettingsPanelProps = {}) {
  const { t } = useTranslation();
  const legacyNovelId =
    typeof novelId === "number" && novelId > 0 ? novelId : null;
  const resolvedTarget: ReaderSettingsPanelTarget =
    target ??
    (legacyNovelId
      ? { kind: "novel", novelId: legacyNovelId }
      : { kind: "global" });
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
  const customCssPresetValue = getCustomCssPresetValue(appearance.customCss);
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

  function resetActiveReaderSettings(): void {
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
    resetReaderSettings();
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

  const automationSettings = (
    <SettingsSection title={t("readerSettings.automation.title")}>
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
              value={general.autoScrollInterval}
              min={16}
              max={500}
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
              value={general.autoScrollOffset}
              min={0.25}
              max={12}
              step={0.25}
              onChange={(value) => {
                if (typeof value === "number") {
                  setActiveGeneral({ autoScrollOffset: value });
                }
              }}
            />
          </SettingsFieldRow>
        </>
      ) : null}
    </SettingsSection>
  );

  return (
    <Stack gap="md">
      <div
        className="lnr-reader-settings-scope-card"
        data-enabled={targetSettingsEnabled}
        data-scope={targetKind}
      >
        <div className="lnr-reader-settings-scope-main">
          <span className="lnr-reader-settings-scope-title">
            {scopeTitle}
          </span>
          <span className="lnr-reader-settings-scope-description">
            {scopeDescription}
          </span>
        </div>
        <span className="lnr-reader-settings-scope-badge">
          {scopeBadge}
        </span>
      </div>
      {targetKind !== "global" ? (
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
              checked={targetSettingsEnabled}
              onChange={(event) =>
                handleTargetSettingsEnabledChange(event.currentTarget.checked)
              }
            />
          </SettingsFieldRow>
        </SettingsSection>
      ) : null}
      {settingsLocked ? (
        <div className="lnr-reader-settings-disabled-notice" role="status">
          <span className="lnr-reader-settings-disabled-title">
            {t("readerSettings.scope.disabledTitle")}
          </span>
          <span className="lnr-reader-settings-disabled-description">
            {t("readerSettings.scope.disabledDescription", {
              scope: appliedScopeLabel,
            })}
          </span>
        </div>
      ) : (
        <fieldset className="lnr-reader-settings-controls">
          <Tabs
            className="lnr-reader-settings-tabs"
            defaultValue="reading"
            keepMounted={false}
          >
      <Tabs.List className="lnr-reader-settings-tab-list">
        <Tabs.Tab value="reading">
          {t("readerSettings.reading.title")}
        </Tabs.Tab>
        <Tabs.Tab value="text">{t("readerSettings.text.title")}</Tabs.Tab>
        <Tabs.Tab value="controls">
          {t("readerSettings.controls.title")}
        </Tabs.Tab>
        {!inlineAutomation ? (
          <Tabs.Tab value="automation">
            {t("readerSettings.automation.title")}
          </Tabs.Tab>
        ) : null}
        <Tabs.Tab value="indicators">
          {t("readerSettings.indicators.title")}
        </Tabs.Tab>
        <Tabs.Tab value="advanced">{t("readerSettings.advanced")}</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel className="lnr-reader-settings-tab-panel" value="reading">
        <Stack gap="lg">
          <SettingsSection title={t("readerSettings.reading.title")}>
        <SettingsFieldRow
          label={t("readerSettings.readingMode")}
          description={t("readerSettings.readingMode.description")}
        >
          <SegmentedToggle
            data={[
              { value: "scroll", label: t("readerSettings.scroll") },
              { value: "paged", label: t("readerSettings.paged") },
              { value: "two-page", label: t("readerSettings.twoPage") },
            ]}
            value={readerMode}
            onChange={(value) => {
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
            }}
          />
        </SettingsFieldRow>
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
      </SettingsSection>
          {inlineAutomation ? automationSettings : null}
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel className="lnr-reader-settings-tab-panel" value="text">
        <Stack gap="lg">
      <SettingsSection
        title={t("readerSettings.text.title")}
      >
        <SettingsFieldRow
          label={t("readerSettings.readerTheme")}
          description={t("readerSettings.readerTheme.description")}
        >
          <Select
            data={readerThemes.map((theme) => ({
              value: theme.id,
              label: getReaderThemeLabel(theme.id, theme.label, t),
            }))}
            value={appearance.themeId}
            onChange={(themeId) => {
              const nextTheme = readerThemes.find(
                (theme) => theme.id === themeId,
              );
              if (nextTheme) applyActiveTheme(nextTheme);
            }}
          />
        </SettingsFieldRow>
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
        <SettingsFieldRow
          label={t("readerSettings.textColor")}
          description={t("readerSettings.textColor.description")}
        >
          <ColorInput
            value={appearance.textColor}
            onChange={(textColor) => setActiveAppearance({ textColor })}
          />
        </SettingsFieldRow>
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
        <SettingsFieldRow
          label={t("readerSettings.font")}
          description={t("readerSettings.font.description")}
        >
          <Select
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
        <SettingsFieldRow
          label={t("readerSettings.alignment")}
          description={t("readerSettings.alignment.description")}
        >
          <SegmentedToggle
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
        <SettingsFieldRow
          label={t("readerSettings.actions")}
          description={t("readerSettings.actions.description")}
        >
          <SettingsInlineControls>
            <TextButton variant="default" onClick={handleSaveCustomTheme}>
              {t("readerSettings.saveCustomTheme")}
            </TextButton>
            <TextButton variant="default" onClick={resetActiveReaderSettings}>
              {t("common.reset")}
            </TextButton>
          </SettingsInlineControls>
        </SettingsFieldRow>
      </SettingsSection>
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel className="lnr-reader-settings-tab-panel" value="controls">
        <Stack gap="lg">
      <SettingsSection
        title={t("readerSettings.controls.title")}
      >
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
              <div className="lnr-reader-tap-preset-grid">
                {READER_TAP_PRESETS.map((preset, index) => (
                  <TapZonePresetCard
                    key={preset.id}
                    index={index}
                    preset={preset}
                    selected={preset.id === general.tapZonePresetId}
                    onApply={handleApplyTapZonePreset}
                  />
                ))}
              </div>
            </SettingsWideField>
          </SettingsFieldRow>
        ) : null}
      </SettingsSection>
        </Stack>
      </Tabs.Panel>

      {!inlineAutomation ? (
        <Tabs.Panel className="lnr-reader-settings-tab-panel" value="automation">
          <Stack gap="lg">{automationSettings}</Stack>
        </Tabs.Panel>
      ) : null}

      <Tabs.Panel className="lnr-reader-settings-tab-panel" value="indicators">
        <Stack gap="lg">
      <SettingsSection
        title={t("readerSettings.indicators.title")}
      >
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
      </SettingsSection>
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel className="lnr-reader-settings-tab-panel" value="advanced">
        <Stack gap="lg">
          <SettingsSection title={t("readerSettings.advanced")}>
            <Stack gap="md">
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
                      removeExtraParagraphSpacing:
                        event.currentTarget.checked,
                    })
                  }
                />
              </SettingsFieldRow>
              <SettingsFieldRow
                label={t("readerSettings.customCssPreset")}
                description={t("readerSettings.customCssPreset.description")}
              >
                <Select
                  data={customCssPresetOptions}
                  value={customCssPresetValue}
                  onChange={handleCustomCssPresetChange}
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
            </Stack>
          </SettingsSection>
        </Stack>
      </Tabs.Panel>
          </Tabs>
        </fieldset>
      )}
    </Stack>
  );
}

function getCustomCssPresetValue(
  customCss: string,
): ReaderCustomCssPresetSelectValue {
  const normalizedCustomCss = customCss.trim();
  if (!normalizedCustomCss) return "none";
  const preset = READER_CUSTOM_CSS_PRESETS.find(
    (entry) => entry.css.trim() === normalizedCustomCss,
  );
  return preset?.id ?? "custom";
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
      <div className="lnr-settings-slider-control">
        <Text className="lnr-settings-slider-value">{valueLabel}</Text>
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
  index,
  preset,
  selected,
  onApply,
}: {
  index: number;
  preset: ReaderTapPreset;
  selected: boolean;
  onApply: (presetId: ReaderTapPresetId) => void;
}) {
  const { t } = useTranslation();

  return (
    <UnstyledButton
      aria-label={`${t("readerSettings.tapControls")} ${index + 1}`}
      aria-pressed={selected}
      className="lnr-reader-tap-preset"
      data-selected={selected}
      onClick={() => onApply(preset.id)}
      type="button"
    >
      <TapZonePreview preset={preset} />
    </UnstyledButton>
  );
}

function TapZonePreview({ preset }: { preset: ReaderTapPreset }) {
  const { t } = useTranslation();
  const actions = READER_TAP_ZONES.map((zone) => preset.zones[zone]);

  return (
    <SimpleGrid cols={3} spacing={4}>
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

function getReaderThemeLabel(
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
      return "var(--mantine-color-blue-0)";
    case "next":
      return "var(--mantine-color-teal-0)";
    case "menu":
      return "var(--mantine-color-yellow-0)";
    case "none":
      return "var(--mantine-color-gray-0)";
  }
}

function getTapActionColor(action: ReaderTapAction): string {
  switch (action) {
    case "previous":
      return "var(--mantine-color-blue-9)";
    case "next":
      return "var(--mantine-color-teal-9)";
    case "menu":
      return "var(--mantine-color-yellow-9)";
    case "none":
      return "var(--mantine-color-gray-7)";
  }
}
