import { Stack, Switch, Text } from "@mantine/core";
import { useTranslation } from "../i18n";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { VpnDownloadLaunchOptions } from "../lib/tasks/vpn-download-types";
import { useVpnDownloadStore } from "../store/vpn-download";
import { SettingsFieldRow } from "./SettingsPrimitives";

export function VpnDownloadSettings({ capabilities, disabled = false }: {
  capabilities: VpnDownloadRuntimeSnapshot["capabilities"];
  value: VpnDownloadLaunchOptions;
  onChange: (value: VpnDownloadLaunchOptions) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const resumeAfterRestart = useVpnDownloadStore(state => state.resumeAfterRestart);
  const setResumeAfterRestart = useVpnDownloadStore(state => state.setResumeAfterRestart);
  const useTestedServers = useVpnDownloadStore(state => state.useTestedServers);
  const setUseTestedServers = useVpnDownloadStore(state => state.setUseTestedServers);
  const unavailable = disabled || !capabilities.supported;

  return (
    <Stack gap="sm">
      <SettingsFieldRow label={t("vpnDownload.workerCount")} description={t("vpnDownload.workerCountHint")}>
        <Text className="norea-settings-inline-value" size="sm">{t("vpnDownload.workerCountSingle")}</Text>
      </SettingsFieldRow>
      <Text size="sm">{t("vpnDownload.errorStopHint")}</Text>
      <Switch aria-label={t("vpnDownload.resumeAfterRestart")} checked={resumeAfterRestart} disabled={unavailable}
        label={t("vpnDownload.resumeAfterRestart")} description={t("vpnDownload.resumeAfterRestartHint")} labelPosition="left"
        onChange={event => { if (!unavailable) setResumeAfterRestart(event.currentTarget.checked); }} />
      <Switch aria-label={t("vpnDownload.useTestedServers")} checked={useTestedServers} disabled={unavailable}
        label={t("vpnDownload.useTestedServers")} description={t("vpnDownload.useTestedServersHint")} labelPosition="left"
        onChange={event => { if (!unavailable) setUseTestedServers(event.currentTarget.checked); }} />
    </Stack>
  );
}
