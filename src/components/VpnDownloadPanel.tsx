import { useRef, useState } from "react";
import { Accordion, Alert, Group, Modal, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import { listSavedPluginVpnProfiles, SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY } from "../lib/plugin-vpn-profiles";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { VpnDownloadLaunchOptions, VpnDownloadRunSnapshot } from "../lib/tasks/vpn-download-types";
import {
  startVpnDownloadRun, pauseVpnDownloadRun, resumeVpnDownloadRun, cancelVpnDownloadRun,
  pauseVpnDownloadWork, resumeVpnDownloadWork,
  startVpnDownloadDraft,
  cancelVpnDownloadDraft, cancelVpnDownloadHandoverWork, resumeVpnDownloadRange, pauseVpnDownloadRange,
  cancelVpnDownloadRange, openVpnDownloadVerification,
} from "../lib/tasks/vpn-download-runtime";
import { useVpnDownloadStore } from "../store/vpn-download";
import { SettingsInlineControls } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";
import { useConfirm } from "./ui/ConfirmDialog";
import { VpnDownloadRanges } from "./VpnDownloadRanges";
import { VpnDownloadSettings } from "./VpnDownloadSettings";

const actions = { retryDraft: startVpnDownloadDraft, pauseWork: pauseVpnDownloadWork, resumeWork: resumeVpnDownloadWork, cancelDraft: cancelVpnDownloadDraft, cancelHandoverWork: cancelVpnDownloadHandoverWork, resumeRange: resumeVpnDownloadRange,
  pauseRange: pauseVpnDownloadRange, cancelRange: cancelVpnDownloadRange, openVerification: openVpnDownloadVerification };
const RUN_STATUS_KEYS: Record<VpnDownloadRunSnapshot["status"], TranslationKey> = {
  starting: "vpnDownload.phase.preparing", running: "vpnDownload.phase.running", paused: "vpnDownload.phase.paused",
  interrupted: "vpnDownload.phase.interrupted", completed: "vpnDownload.phase.completed",
  cancelling: "vpnDownload.phase.cancelling", cancelled: "vpnDownload.phase.cancelled",
};

export function VpnDownloadPanel({ snapshot }: { snapshot: VpnDownloadRuntimeSnapshot }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const workerCount = useVpnDownloadStore(state => state.workerCount);
  const captchaPolicy = useVpnDownloadStore(state => state.captchaPolicy);
  const cloudflarePolicy = useVpnDownloadStore(state => state.cloudflarePolicy);
  const [opened, setOpened] = useState(false);
  const [options, setOptions] = useState<VpnDownloadLaunchOptions>(() => ({ workerCount, captchaPolicy, cloudflarePolicy }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const vault = useQuery({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, queryFn: listSavedPluginVpnProfiles, meta: { errorPresentation: "inline" } });
  const run = snapshot.run;
  const hasRun = Boolean(run && run.status !== "completed" && run.status !== "cancelled");
  const canStart = !snapshot.loading && !vault.isPending && !vault.isError && !vault.data?.cleanupError && snapshot.capabilities.supported;
  const maxWorkers = snapshot.capabilities.parallelSupported ? Math.max(1, snapshot.capabilities.maxWorkers) : 1;

  async function act(action: () => Promise<void>, close = false): Promise<void> {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await action(); if (close) setOpened(false); }
    catch (error) { setError(describeError(error)); }
    finally { busy.current = false; setPending(false); }
  }

  return (
    <Stack gap="md" className="norea-vpn-download-queue" component="section" aria-label={t("vpnDownload.queue")}>
      <Group justify="space-between" align="flex-start" gap="sm">
        <Stack gap="xs" className="norea-vpn-download-heading">
          <Text component="h2" size="md" fw={600}>{t("vpnDownload.queue")}</Text>
          {run ? <Text size="sm" role="status">{t(RUN_STATUS_KEYS[run.status])}</Text> : <Text size="sm" c="dimmed">{t("vpnDownload.launchHint")}</Text>}
          {hasRun && run ? <>
            <Text size="sm">{t("vpnDownload.connections", { active: run.activeWorkers, target: run.workerCount })}</Text>
            {run.connectingWorkers || run.closingWorkers ? <Text size="sm" c="dimmed">{t("vpnDownload.workerLifecycle", { connecting: run.connectingWorkers, closing: run.closingWorkers })}</Text> : null}
          </> : null}
        </Stack>
        <SettingsInlineControls>
          {!hasRun ? <TextButton tone="accent" disabled={pending} onClick={() => {
            setOptions({ workerCount: Math.min(workerCount, maxWorkers), captchaPolicy, cloudflarePolicy });
            setError(null); setOpened(true);
          }}>{t("vpnDownload.launch")}</TextButton> : <>
            {run?.status === "paused" || run?.status === "interrupted" ?
              <TextButton disabled={pending} loading={pending} onClick={() => act(resumeVpnDownloadRun)}>{t("vpnDownload.resume")}</TextButton> :
              <TextButton disabled={pending || run?.status === "cancelling"} onClick={() => act(pauseVpnDownloadRun)}>{t("vpnDownload.pause")}</TextButton>}
            <TextButton tone="danger" disabled={pending || run?.status === "cancelling"} onClick={async () => {
              const confirmed = await confirm({ title: t("vpnDownload.cancelRunConfirm.title"), message: t("vpnDownload.cancelRunConfirm.message"),
                confirmLabel: t("vpnDownload.cancelRun"), cancelLabel: t("common.keep"), danger: true });
              if (confirmed) await act(cancelVpnDownloadRun);
            }}>{t("vpnDownload.cancelRun")}</TextButton>
          </>}
        </SettingsInlineControls>
      </Group>
      {snapshot.loading || vault.isPending ? <Text size="sm" role="status">{t("vpnDownload.loading")}</Text> : null}
      {!snapshot.capabilities.supported && !snapshot.loading ? <Text size="sm">{t("vpnDownload.unsupported")}</Text> : null}
      {snapshot.error ? <Alert color="danger" role="alert">{snapshot.error}</Alert> : null}
      {error && !opened ? <Alert color="danger" role="alert">{error}</Alert> : null}
      {vault.isError ? <Alert color="danger" role="alert">
        <Text size="sm">{describeError(vault.error)}</Text>
        <TextButton onClick={() => { void vault.refetch(); }}>{t("common.retry")}</TextButton>
      </Alert> : null}
      {vault.data?.cleanupError ? <Alert color="danger" role="alert">{vault.data.cleanupError}</Alert> : null}
      <VpnDownloadRanges snapshot={snapshot} profiles={vault.data?.profiles ?? []} actions={actions} />
      {!snapshot.loading && !snapshot.drafts.length && !snapshot.plans.length && !snapshot.handover?.length ? <Text size="sm" c="dimmed">{t("vpnDownload.empty")}</Text> : null}
      <Modal opened={opened} onClose={() => { if (!busy.current) setOpened(false); }} title={t("vpnDownload.launch")}
        closeOnEscape={!pending} closeOnClickOutside={!pending} closeButtonProps={{ disabled: pending, "aria-label": t("common.cancel"), size: "lg" }} returnFocus>
        <Stack gap="md">
          <Text size="sm">{t("vpnDownload.launchHint")}</Text>
          <Text size="sm" fw={600}>{t("vpnDownload.workerTarget", { count: options.workerCount })}</Text>
          <Text size="sm">{t("vpnDownload.policySummary", { captcha: t(`vpnDownload.policy.${options.captchaPolicy}`), cloudflare: t(`vpnDownload.policy.${options.cloudflarePolicy}`) })}</Text>
          {!snapshot.capabilities.supported ? <Alert color="warn">{t("vpnDownload.unsupported")}</Alert> : null}
          {!vault.isPending && !vault.isError && vault.data?.profiles.length === 0 ? <Alert color="warn">{t("vpnDownload.noProfiles")}</Alert> : null}
          <Accordion variant="default">
            <Accordion.Item value="options">
              <Accordion.Control>{t("vpnDownload.optionalSettings")}</Accordion.Control>
              <Accordion.Panel><VpnDownloadSettings capabilities={snapshot.capabilities} value={options} onChange={setOptions} disabled={pending} /></Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          {error ? <Alert color="danger" role="alert">{error}</Alert> : null}
          <SettingsInlineControls>
            <TextButton tone="accent" data-autofocus disabled={!canStart || pending} loading={pending}
              onClick={() => { if (canStart) return act(() => startVpnDownloadRun(options), true); }}>{t("vpnDownload.start")}</TextButton>
            <TextButton disabled={pending} onClick={() => { if (!busy.current) setOpened(false); }}>{t("common.cancel")}</TextButton>
          </SettingsInlineControls>
        </Stack>
      </Modal>
    </Stack>
  );
}
