import { NumberInput, Select, Stack, Switch } from "@mantine/core";
import { useTranslation } from "../i18n";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import { MAX_VPN_DOWNLOAD_WORKERS, type VpnDownloadLaunchOptions } from "../lib/tasks/vpn-download-types";
import { useVpnDownloadStore } from "../store/vpn-download";
import { SettingsFieldRow } from "./SettingsPrimitives";

export function VpnDownloadSettings({ capabilities, value, onChange, disabled = false }: {
  capabilities: VpnDownloadRuntimeSnapshot["capabilities"];
  value: VpnDownloadLaunchOptions;
  onChange: (value: VpnDownloadLaunchOptions) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const resumeAfterRestart = useVpnDownloadStore(state => state.resumeAfterRestart);
  const setResumeAfterRestart = useVpnDownloadStore(state => state.setResumeAfterRestart);
  const maxWorkers = capabilities.parallelSupported ? Math.max(1, Math.min(MAX_VPN_DOWNLOAD_WORKERS, capabilities.maxWorkers)) : 1;
  const unavailable = disabled || !capabilities.supported;
  const policyOptions = [{ value: "nextProfile", label: t("vpnDownload.policy.nextProfile") }, { value: "pause", label: t("vpnDownload.policy.pause") }];

  return (
    <Stack gap="sm">
      <SettingsFieldRow label={t("vpnDownload.workerCount")} description={t("vpnDownload.workerCountHint")}>
        <NumberInput aria-label={t("vpnDownload.workerCount")} value={value.workerCount} min={1} max={maxWorkers}
          allowDecimal={false} allowNegative={false} disabled={unavailable}
          onChange={count => {
            if (!unavailable && typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= maxWorkers) onChange({ ...value, workerCount: count });
          }} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t("vpnDownload.captchaPolicy")}>
        <Select aria-label={t("vpnDownload.captchaPolicy")} value={value.captchaPolicy} data={policyOptions} allowDeselect={false} disabled={unavailable}
          onChange={policy => { if (!unavailable && (policy === "pause" || policy === "nextProfile")) onChange({ ...value, captchaPolicy: policy }); }} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t("vpnDownload.cloudflarePolicy")}>
        <Select aria-label={t("vpnDownload.cloudflarePolicy")} value={value.cloudflarePolicy} data={policyOptions} allowDeselect={false} disabled={unavailable}
          onChange={policy => { if (!unavailable && (policy === "pause" || policy === "nextProfile")) onChange({ ...value, cloudflarePolicy: policy }); }} />
      </SettingsFieldRow>
      <Switch aria-label={t("vpnDownload.resumeAfterRestart")} checked={resumeAfterRestart} disabled={unavailable}
        label={t("vpnDownload.resumeAfterRestart")} description={t("vpnDownload.resumeAfterRestartHint")} labelPosition="left"
        onChange={event => { if (!unavailable) setResumeAfterRestart(event.currentTarget.checked); }} />
    </Stack>
  );
}
