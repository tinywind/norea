import { useMemo } from "react";
import {
  ColorInput,
  Select,
  Stack,
  Switch,
  useComputedColorScheme,
} from "@mantine/core";
import {
  SettingsAdvancedGroup,
  SettingsFieldRow,
  SettingsPercentSlider,
  SettingsSection,
  SettingsWideField,
} from "../SettingsPrimitives";
import { isAndroidRuntime } from "../../lib/tauri-runtime";
import { useTranslation } from "../../i18n";
import {
  MAX_ANDROID_VIEW_SCALE_PERCENT,
  MAX_FONT_SCALE_PERCENT,
  MIN_ANDROID_VIEW_SCALE_PERCENT,
  MIN_FONT_SCALE_PERCENT,
  normalizeAppThemeMode,
  useAppearanceStore,
} from "../../store/appearance";
import { APP_THEMES, type AppThemeId } from "../../theme/md3";
import { resolvePaletteRoles } from "../../theme/palette-roles";

const SCALE_STEP_PERCENT = 5;

function ThemeSwatches({
  value,
  onChange,
}: {
  value: AppThemeId;
  onChange: (id: AppThemeId) => void;
}) {
  const { t } = useTranslation();
  const scheme = useComputedColorScheme("light");
  const swatches = useMemo(
    () =>
      APP_THEMES.map((theme) => {
        const roles = resolvePaletteRoles(theme[scheme], scheme, {
          customAccent: false,
        });
        return {
          id: theme.id,
          label: theme.label,
          background: roles.bg,
          surface: roles.surfaceRaised,
          accent: roles.accent,
        };
      }),
    [scheme],
  );

  return (
    <div
      aria-label={t("settings.app.appTheme.label")}
      className="norea-settings-theme-swatches"
      role="radiogroup"
    >
      {swatches.map((swatch) => (
        <button
          aria-checked={swatch.id === value}
          className="norea-settings-theme-swatch norea-state-layer"
          key={swatch.id}
          onClick={() => onChange(swatch.id)}
          role="radio"
          type="button"
        >
          <span
            aria-hidden="true"
            className="norea-settings-theme-swatch-preview"
            style={{ background: swatch.background }}
          >
            <span style={{ background: swatch.surface }} />
            <span style={{ background: swatch.accent }} />
          </span>
          <span className="norea-settings-theme-swatch-label">{swatch.label}</span>
        </button>
      ))}
    </div>
  );
}

export function AppearanceSection() {
  const appearance = useAppearanceStore();
  const { t } = useTranslation();
  const showAndroidViewScale = isAndroidRuntime();

  return (
    <Stack gap="md">
      <SettingsSection title={t("settings.app.appearance.title")}>
        <SettingsFieldRow
          label={t("settings.app.themeMode.label")}
          description={t("settings.app.themeMode.description")}
        >
          <Select
            data={[
              { value: "system", label: t("settings.app.themeMode.system") },
              { value: "light", label: t("settings.app.themeMode.light") },
              { value: "dark", label: t("settings.app.themeMode.dark") },
            ]}
            value={appearance.themeMode}
            onChange={(themeMode) =>
              appearance.setThemeMode(normalizeAppThemeMode(themeMode))
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.appTheme.label")}
          description={t("settings.app.appTheme.description")}
          layout="stacked"
        >
          <SettingsWideField>
            <ThemeSwatches
              value={appearance.appThemeId}
              onChange={appearance.setAppThemeId}
            />
          </SettingsWideField>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.amoled.label")}
          description={t("settings.app.amoled.description")}
        >
          <Switch
            checked={appearance.amoledBlack}
            onChange={(event) =>
              appearance.setAmoledBlack(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsPercentSlider
          label={t("settings.app.fontScale.label")}
          description={t("settings.app.fontScale.description")}
          value={appearance.fontScalePercent}
          min={MIN_FONT_SCALE_PERCENT}
          max={MAX_FONT_SCALE_PERCENT}
          step={SCALE_STEP_PERCENT}
          onChange={appearance.setFontScalePercent}
        />
        {showAndroidViewScale ? (
          <SettingsPercentSlider
            label={t("settings.app.androidViewScale.label")}
            description={t("settings.app.androidViewScale.description")}
            value={appearance.androidViewScalePercent}
            min={MIN_ANDROID_VIEW_SCALE_PERCENT}
            max={MAX_ANDROID_VIEW_SCALE_PERCENT}
            step={SCALE_STEP_PERCENT}
            onChange={appearance.setAndroidViewScalePercent}
          />
        ) : null}
        <SettingsFieldRow
          label={t("settings.app.navLabels.label")}
          description={t("settings.app.navLabels.description")}
        >
          <Switch
            checked={appearance.showLabelsInNav}
            onChange={(event) =>
              appearance.setShowLabelsInNav(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsAdvancedGroup>
          <SettingsFieldRow
            label={t("settings.app.customAccent.label")}
            description={t("settings.app.customAccent.description")}
          >
            <ColorInput
              value={appearance.customAccentColor}
              placeholder={t("settings.app.customAccent.placeholder")}
              onChange={appearance.setCustomAccentColor}
            />
          </SettingsFieldRow>
        </SettingsAdvancedGroup>
      </SettingsSection>
    </Stack>
  );
}
