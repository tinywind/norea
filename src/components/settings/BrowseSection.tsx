import { Stack, Switch } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { SettingsFieldRow, SettingsSection } from "../SettingsPrimitives";
import {
  applyAutomaticExtensionUpdates,
  reportAutomaticExtensionUpdates,
} from "../browse/use-plugin-catalog";
import { useTranslation } from "../../i18n";
import { useBrowseStore } from "../../store/browse";

export function BrowseSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const autoUpdateExtensions = useBrowseStore((state) => state.autoUpdateExtensions);
  const setAutoUpdateExtensions = useBrowseStore((state) => state.setAutoUpdateExtensions);

  const toggle = (enabled: boolean) => {
    setAutoUpdateExtensions(enabled);
    if (!enabled) return;
    void applyAutomaticExtensionUpdates(queryClient)
      .then(reportAutomaticExtensionUpdates)
      .catch((error) => console.warn("[settings:browse] automatic extension updates failed", error));
  };

  return (
    <Stack gap="md">
      <SettingsSection title={t("settings.browse.extensions.title")}>
        <SettingsFieldRow
          label={t("settings.browse.autoUpdateExtensions.label")}
          description={t("settings.browse.autoUpdateExtensions.description")}
        >
          <Switch
            checked={autoUpdateExtensions}
            onChange={(event) => toggle(event.currentTarget.checked)}
          />
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}
