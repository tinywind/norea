import { NumberInput, Select, Text } from "@mantine/core";
import { useTranslation } from "../i18n";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import { useVpnDownloadStore } from "../store/vpn-download";
import { SettingsFieldRow, SettingsSection } from "./SettingsPrimitives";

export function VpnDownloadSettings({ capabilities, hasPlans }: {
  capabilities: VpnDownloadRuntimeSnapshot["capabilities"];
  hasPlans: boolean;
}) {
  const { t } = useTranslation();
  const mode = useVpnDownloadStore(state => state.mode);
  const workerCount = useVpnDownloadStore(state => state.workerCount);
  const captchaPolicy = useVpnDownloadStore(state => state.captchaPolicy);
  const cloudflarePolicy = useVpnDownloadStore(state => state.cloudflarePolicy);
  const setMode = useVpnDownloadStore(state => state.setMode);
  const setWorkerCount = useVpnDownloadStore(state => state.setWorkerCount);
  const setCaptchaPolicy = useVpnDownloadStore(state => state.setCaptchaPolicy);
  const setCloudflarePolicy = useVpnDownloadStore(state => state.setCloudflarePolicy);
  const single = capabilities.supported && capabilities.maxWorkers >= 1;
  const parallel = single && capabilities.parallelSupported && capabilities.maxWorkers >= 2;
  const maxWorkers = Math.max(1, Math.min(2, capabilities.maxWorkers));
  const policyOptions = [{ value: "pause", label: t("vpnDownload.policy.pause") }, { value: "nextProfile", label: t("vpnDownload.policy.nextProfile") }];

  return (
    <SettingsSection title={t("vpnDownload.title")} description={t("vpnDownload.description")}>
      <SettingsFieldRow label={t("vpnDownload.mode")} description={t("vpnDownload.offHint")}>
        <Select aria-label={t("vpnDownload.mode")} value={mode} allowDeselect={false}
          data={[
            { value: "off", label: t("vpnDownload.mode.off") },
            { value: "single", label: t("vpnDownload.mode.single"), disabled: !single },
            { value: "parallel", label: t("vpnDownload.mode.parallel"), disabled: !parallel },
          ]}
          onChange={value => {
            if (value === "off" || (value === "single" && single) || (value === "parallel" && parallel)) setMode(value);
          }} />
      </SettingsFieldRow>
      {!single ? <Text size="sm">{t("vpnDownload.unsupported")}</Text> : !parallel ? <Text size="sm">{t("vpnDownload.parallelUnsupported")}</Text> : null}
      {mode === "parallel" ? (
        <SettingsFieldRow label={t("vpnDownload.workerCount")} description={t("vpnDownload.workerCountHint")}>
          <NumberInput aria-label={t("vpnDownload.workerCount")} value={workerCount} min={1} max={maxWorkers}
            allowDecimal={false} allowNegative={false} disabled={!parallel}
            onChange={value => { if (parallel && typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maxWorkers) setWorkerCount(value); }} />
        </SettingsFieldRow>
      ) : null}
      <SettingsFieldRow label={t("vpnDownload.captchaPolicy")}>
        <Select aria-label={t("vpnDownload.captchaPolicy")} value={captchaPolicy} data={policyOptions} allowDeselect={false} disabled={!single || mode === "off"}
          onChange={value => { if (single && mode !== "off" && (value === "pause" || value === "nextProfile")) setCaptchaPolicy(value); }} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t("vpnDownload.cloudflarePolicy")}>
        <Select aria-label={t("vpnDownload.cloudflarePolicy")} value={cloudflarePolicy} data={policyOptions} allowDeselect={false} disabled={!single || mode === "off"}
          onChange={value => { if (single && mode !== "off" && (value === "pause" || value === "nextProfile")) setCloudflarePolicy(value); }} />
      </SettingsFieldRow>
      {hasPlans ? <Text size="sm" c="dimmed">{t("vpnDownload.newBatchesOnly")}</Text> : null}
    </SettingsSection>
  );
}
