import { useEffect, useState } from "react";
import { Text } from "@mantine/core";
import { useTranslation } from "../i18n";
import { androidAllFilesAccessGranted, requestAndroidAllFilesAccess } from "../lib/android-all-files-access";
import { IconButton } from "./IconButton";
import { SettingsFieldRow, SettingsInlineControls } from "./SettingsPrimitives";
import { SettingsIcon } from "./ui/icons";

/**
 * Android's All files access for the storage folder. Without it every storage lookup goes through
 * the document provider, which makes work merges, their recovery and deletions take minutes.
 * Renders nothing outside the Android host.
 */
export function AllFilesAccessSetting() {
  const { t } = useTranslation();
  const [granted, setGranted] = useState(androidAllFilesAccessGranted);
  const [openFailed, setOpenFailed] = useState(false);

  useEffect(() => {
    const refresh = () => setGranted(androidAllFilesAccessGranted());
    window.addEventListener("norea-app-resumed", refresh);
    return () => window.removeEventListener("norea-app-resumed", refresh);
  }, []);

  if (granted === null) return null;
  return (
    <SettingsFieldRow
      description={t("settings.data.mediaStorage.allFiles.description")}
      error={openFailed ? t("settings.data.mediaStorage.allFiles.openFailed") : null}
      label={t("settings.data.mediaStorage.allFiles.label")}
    >
      <SettingsInlineControls compact>
        <Text className="norea-settings-inline-value" size="sm">
          {t(granted ? "settings.data.mediaStorage.allFiles.granted" : "settings.data.mediaStorage.allFiles.denied")}
        </Text>
        {granted ? null : (
          <IconButton
            label={t("settings.data.mediaStorage.allFiles.request")}
            onClick={() => setOpenFailed(!requestAndroidAllFilesAccess())}
            size="lg"
          >
            <SettingsIcon />
          </IconButton>
        )}
      </SettingsInlineControls>
    </SettingsFieldRow>
  );
}
