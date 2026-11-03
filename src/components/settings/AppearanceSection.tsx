import {
  ColorInput,
  NumberInput,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { SettingsFieldRow, SettingsSection } from "../SettingsPrimitives";
import { isAndroidRuntime } from "../../lib/tauri-runtime";
import { useTranslation } from "../../i18n";
import {
  MAX_ANDROID_VIEW_SCALE_PERCENT,
  MAX_FONT_SCALE_PERCENT,
  MIN_ANDROID_VIEW_SCALE_PERCENT,
  MIN_FONT_SCALE_PERCENT,
  normalizeAppThemeId,
  normalizeAppThemeMode,
  useAppearanceStore,
} from "../../store/appearance";
import { APP_THEME_OPTIONS } from "../../theme/md3";

const ROOT_FONT_SIZE_PX = 16;
const MIN_ROOT_FONT_SIZE_PX = Math.round(
  (ROOT_FONT_SIZE_PX * MIN_FONT_SCALE_PERCENT) / 100,
);
const MAX_ROOT_FONT_SIZE_PX = Math.round(
  (ROOT_FONT_SIZE_PX * MAX_FONT_SCALE_PERCENT) / 100,
);

function fontScalePercentToRootFontSize(fontScalePercent: number): number {
  return Math.round((ROOT_FONT_SIZE_PX * fontScalePercent) / 100);
}

function rootFontSizeToFontScalePercent(rootFontSize: unknown): number {
  return (Number(rootFontSize) / ROOT_FONT_SIZE_PX) * 100;
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
        >
          <Select
            data={APP_THEME_OPTIONS}
            value={appearance.appThemeId}
            onChange={(appThemeId) =>
              appearance.setAppThemeId(normalizeAppThemeId(appThemeId))
            }
          />
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
        <SettingsFieldRow
          label={t("settings.app.fontScale.label")}
          description={t("settings.app.fontScale.description")}
        >
          <NumberInput
            value={fontScalePercentToRootFontSize(appearance.fontScalePercent)}
            min={MIN_ROOT_FONT_SIZE_PX}
            max={MAX_ROOT_FONT_SIZE_PX}
            step={1}
            suffix="px"
            onChange={(rootFontSize) =>
              appearance.setFontScalePercent(
                rootFontSizeToFontScalePercent(rootFontSize),
              )
            }
          />
        </SettingsFieldRow>
        {showAndroidViewScale ? (
          <SettingsFieldRow
            label={t("settings.app.androidViewScale.label")}
            description={t("settings.app.androidViewScale.description")}
          >
            <div className="norea-settings-slider-control">
              <Text className="norea-settings-slider-value">
                {appearance.androidViewScalePercent}%
              </Text>
              <Slider
                value={appearance.androidViewScalePercent}
                min={MIN_ANDROID_VIEW_SCALE_PERCENT}
                max={MAX_ANDROID_VIEW_SCALE_PERCENT}
                step={5}
                label={(value) => `${value}%`}
                marks={[
                  { value: MIN_ANDROID_VIEW_SCALE_PERCENT, label: "75%" },
                  { value: MAX_ANDROID_VIEW_SCALE_PERCENT, label: "100%" },
                ]}
                onChange={appearance.setAndroidViewScalePercent}
              />
            </div>
          </SettingsFieldRow>
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
      </SettingsSection>
    </Stack>
  );
}
