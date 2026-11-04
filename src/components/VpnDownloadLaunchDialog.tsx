import { useRef, useState } from "react";
import { Accordion, Alert, Button, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { listSavedPluginVpnProfiles, SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY } from "../lib/plugin-vpn-profiles";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { VpnDownloadLaunchOptions } from "../lib/tasks/vpn-download-types";
import { startVpnDownloadRun } from "../lib/tasks/vpn-download-runtime";
import { useVpnDownloadStore } from "../store/vpn-download";
import { TextButton } from "./TextButton";
import { ResponsiveSheet, SheetActions } from "./ui/ResponsiveSheet";
import { VpnDownloadSettings } from "./VpnDownloadSettings";

/** Starts a VPN run over the queued and new chapter downloads. Mount it only while it is open. */
export function VpnDownloadLaunchDialog({ snapshot, onClose }: { snapshot: VpnDownloadRuntimeSnapshot; onClose: () => void }) {
  const { t } = useTranslation();
  const workerCount = useVpnDownloadStore(state => state.workerCount);
  const captchaPolicy = useVpnDownloadStore(state => state.captchaPolicy);
  const cloudflarePolicy = useVpnDownloadStore(state => state.cloudflarePolicy);
  const maxWorkers = snapshot.capabilities.parallelSupported ? Math.max(1, snapshot.capabilities.maxWorkers) : 1;
  const [options, setOptions] = useState<VpnDownloadLaunchOptions>(() => ({ workerCount: Math.min(workerCount, maxWorkers), captchaPolicy, cloudflarePolicy }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const vault = useQuery({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, queryFn: listSavedPluginVpnProfiles, meta: { errorPresentation: "inline" } });
  const canStart = !snapshot.loading && !vault.isPending && !vault.isError && !vault.data?.cleanupError && snapshot.capabilities.supported;
  const close = () => { if (!busy.current) onClose(); };

  async function start(): Promise<void> {
    if (busy.current || !canStart) return;
    busy.current = true; setPending(true); setError(null);
    try { await startVpnDownloadRun(options); onClose(); }
    catch (error) { setError(describeError(error)); }
    finally { busy.current = false; setPending(false); }
  }

  return (
    <ResponsiveSheet busy={pending} closeLabel={t("common.cancel")} opened onClose={close} title={t("vpnDownload.launch")}
      footer={<SheetActions>
        <Button disabled={pending} onClick={close} variant="default">{t("common.cancel")}</Button>
        <Button data-autofocus disabled={!canStart || pending} loading={pending} onClick={start}>{t("vpnDownload.start")}</Button>
      </SheetActions>}>
      <Stack gap="md">
        <Text size="sm">{t("vpnDownload.launchHint")}</Text>
        <Text size="sm" fw="var(--norea-weight-bold)">{t("vpnDownload.workerTarget", { count: options.workerCount })}</Text>
        <Text size="sm">{t("vpnDownload.policySummary", { captcha: t(`vpnDownload.policy.${options.captchaPolicy}`), cloudflare: t(`vpnDownload.policy.${options.cloudflarePolicy}`) })}</Text>
        {snapshot.loading || vault.isPending ? <Text size="sm" role="status">{t("vpnDownload.loading")}</Text> : null}
        {!snapshot.capabilities.supported ? <Alert color="warn">{t("vpnDownload.unsupported")}</Alert> : null}
        {snapshot.error ? <Alert color="danger" role="alert">{snapshot.error}</Alert> : null}
        {vault.isError ? <Alert color="danger" role="alert">
          <Text size="sm">{describeError(vault.error)}</Text>
          <TextButton onClick={() => { void vault.refetch(); }}>{t("common.retry")}</TextButton>
        </Alert> : null}
        {vault.data?.cleanupError ? <Alert color="danger" role="alert">{vault.data.cleanupError}</Alert> : null}
        {!vault.isPending && !vault.isError && vault.data?.profiles.length === 0 ? <Alert color="warn">{t("vpnDownload.noProfiles")}</Alert> : null}
        <Accordion variant="default">
          <Accordion.Item value="options">
            <Accordion.Control>{t("vpnDownload.optionalSettings")}</Accordion.Control>
            <Accordion.Panel><VpnDownloadSettings capabilities={snapshot.capabilities} value={options} onChange={setOptions} disabled={pending} /></Accordion.Panel>
          </Accordion.Item>
        </Accordion>
        {error ? <Alert color="danger" role="alert">{error}</Alert> : null}
      </Stack>
    </ResponsiveSheet>
  );
}
