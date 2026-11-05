import { useEffect, useState } from "react";
import { Text } from "@mantine/core";
import { useTranslation } from "../i18n";
import {
  androidBatteryOptimizationExempt,
  requestAndroidBatteryOptimizationExemption,
} from "../lib/android-battery-optimization";
import { IconButton } from "./IconButton";
import { SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { BatteryIcon } from "./ui/icons";

/**
 * Android's battery optimization exemption, which keeps background downloads
 * running with the screen off on vendors that release wake locks otherwise.
 * Renders nothing outside the Android host.
 */
export function BatteryOptimizationSetting() {
  const { t } = useTranslation();
  const [exempt, setExempt] = useState(androidBatteryOptimizationExempt);
  const [openFailed, setOpenFailed] = useState(false);

  useEffect(() => {
    const refresh = () => setExempt(androidBatteryOptimizationExempt());
    window.addEventListener("norea-app-resumed", refresh);
    return () => window.removeEventListener("norea-app-resumed", refresh);
  }, []);

  if (exempt === null) return null;
  return (
    <SettingsSection>
      <SettingsFieldRow
        description={t("downloads.battery.description")}
        error={openFailed ? t("downloads.battery.openFailed") : null}
        label={t("downloads.battery.label")}
      >
        <SettingsInlineControls compact>
          <Text className="norea-settings-inline-value" size="sm">
            {t(exempt ? "downloads.battery.exempt" : "downloads.battery.optimized")}
          </Text>
          {exempt ? null : (
            <IconButton
              label={t("downloads.battery.request")}
              onClick={() => setOpenFailed(!requestAndroidBatteryOptimizationExemption())}
              size="lg"
            >
              <BatteryIcon />
            </IconButton>
          )}
        </SettingsInlineControls>
      </SettingsFieldRow>
    </SettingsSection>
  );
}
