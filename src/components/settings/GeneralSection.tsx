import { Select, Stack } from "@mantine/core";
import { SettingsFieldRow, SettingsSection } from "../SettingsPrimitives";
import { SUPPORTED_APP_LOCALES, useTranslation } from "../../i18n";
import { DEFAULT_APPEARANCE, useAppearanceStore } from "../../store/appearance";
import {
  normalizeTaskNotificationMode,
  useNotificationStore,
} from "../../store/notifications";

export function GeneralSection() {
  const { t } = useTranslation();
  const appLocale = useAppearanceStore((state) => state.appLocale);
  const setAppLocale = useAppearanceStore((state) => state.setAppLocale);
  const notificationSettings = useNotificationStore();

  return (
    <Stack gap="md">
      <SettingsSection title={t("settings.app.localization.title")}>
        <SettingsFieldRow
          label={t("settings.app.locale.label")}
          description={t("settings.app.locale.description")}
        >
          <Select
            data={SUPPORTED_APP_LOCALES.map((locale) => ({
              value: locale,
              label: t(locale === "ko" ? "locale.ko" : "locale.en"),
            }))}
            value={appLocale}
            onChange={(next) => setAppLocale(next ?? DEFAULT_APPEARANCE.appLocale)}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t("settings.app.notifications.title")}>
        <SettingsFieldRow
          label={t("settings.app.taskNotifications.label")}
          description={t("settings.app.taskNotifications.description")}
        >
          <Select
            data={[
              {
                value: "off",
                label: t("settings.app.taskNotifications.off"),
              },
              {
                value: "completion",
                label: t("settings.app.taskNotifications.completion"),
              },
              {
                value: "progress",
                label: t("settings.app.taskNotifications.progress"),
              },
            ]}
            value={notificationSettings.taskProgressMode}
            onChange={(taskProgressMode) =>
              notificationSettings.setTaskProgressMode(
                normalizeTaskNotificationMode(taskProgressMode),
              )
            }
          />
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}
