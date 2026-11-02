import { useSyncExternalStore } from "react";
import { Alert, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { listSavedPluginVpnProfiles, SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY } from "../lib/plugin-vpn-profiles";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import {
  getVpnDownloadRuntimeSnapshot,
  subscribeVpnDownloadRuntime,
  startVpnDownloadDraft,
  cancelVpnDownloadDraft,
  resumeVpnDownloadRange,
  pauseVpnDownloadRange,
  cancelVpnDownloadRange,
  openVpnDownloadVerification,
} from "../lib/tasks/vpn-download-runtime";
import { TextButton } from "./TextButton";
import { VpnDownloadRanges } from "./VpnDownloadRanges";
import { VpnDownloadSettings } from "./VpnDownloadSettings";

const actions = {
  startDraft: startVpnDownloadDraft,
  cancelDraft: cancelVpnDownloadDraft,
  resumeRange: resumeVpnDownloadRange,
  pauseRange: pauseVpnDownloadRange,
  cancelRange: cancelVpnDownloadRange,
  openVerification: openVpnDownloadVerification,
};

export function VpnDownloadPanel() {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore<VpnDownloadRuntimeSnapshot>(subscribeVpnDownloadRuntime, getVpnDownloadRuntimeSnapshot, getVpnDownloadRuntimeSnapshot);
  const vault = useQuery({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, queryFn: listSavedPluginVpnProfiles, meta: { errorPresentation: "inline" } });
  const reserved = new Set(snapshot.plans.flatMap(plan => plan.ranges.filter(range => range.phase !== "completed" && range.phase !== "cancelled").map(range => range.profileId)));
  const profiles = (vault.data?.profiles ?? []).map(profile => ({
    profile,
    unavailableReason: vault.data?.cleanupError ? t("vpnDownload.profilePoolUnavailable") : reserved.has(profile.id) ? t("vpnDownload.profileInUse") : null,
  }));

  return (
    <Stack gap="md" mt="md">
      <VpnDownloadSettings capabilities={snapshot.capabilities} hasPlans={snapshot.plans.length > 0} />
      {snapshot.loading || vault.isPending ? <Text size="sm" role="status">{t("vpnDownload.loading")}</Text> : null}
      {snapshot.error ? <Alert color="red" role="alert">{snapshot.error}</Alert> : null}
      {vault.isError ? <Alert color="red" role="alert">
        <Text size="sm">{describeError(vault.error)}</Text>
        <TextButton onClick={() => { void vault.refetch(); }}>{t("common.retry")}</TextButton>
      </Alert> : null}
      {vault.data?.cleanupError ? <Alert color="red" role="alert">{vault.data.cleanupError}</Alert> : null}
      <VpnDownloadRanges snapshot={snapshot} profiles={profiles} profilesReady={Boolean(vault.data) && !vault.isPending && !vault.isError && !vault.data?.cleanupError} actions={actions} />
    </Stack>
  );
}
