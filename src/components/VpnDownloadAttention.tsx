import { useRef, useState } from "react";
import { Button, Group, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import { vpnDownloadAttention } from "../lib/tasks/vpn-download-notifications";
import { openVpnDownloadVerification, resumeVpnDownloadRange, resumeVpnDownloadRun } from "../lib/tasks/vpn-download-runtime";

/** One Needs attention line for the VPN problem the app cannot solve by itself. */
export function VpnDownloadAttention({ snapshot }: { snapshot: VpnDownloadRuntimeSnapshot }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const item = snapshot.loading ? null : vpnDownloadAttention(snapshot.plans, snapshot.run?.status);
  if (!item) return null;

  async function act(action: () => Promise<unknown>): Promise<void> {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await action(); }
    catch (error) { setError(describeError(error)); }
    finally { busy.current = false; setPending(false); }
  }

  const [message, label, action] =
    item.kind === "interrupted" ? [t("vpnDownload.attention.interrupted"), t("vpnDownload.resume"), () => resumeVpnDownloadRun()] as const
    : item.kind === "verification" ? [t("vpnDownload.attention.verification", { title: item.title }), t("vpnDownload.attention.verify"),
      () => openVpnDownloadVerification(item.planId, item.rangeId)] as const
    : item.kind === "exhausted" ? [t("vpnDownload.attention.exhausted", { count: item.ranges }), t("vpnDownload.attention.findServers"),
      () => navigate({ to: "/settings", search: { section: "network" } })] as const
    : [t("vpnDownload.attention.failed", { count: item.ranges.length }), t("common.retry"),
      () => Promise.all(item.ranges.map(({ planId, rangeId }) => resumeVpnDownloadRange(planId, rangeId)))] as const;

  return (
    <section className="norea-source-access-banner" role="alert" data-vpn-attention={item.kind}>
      <div className="norea-source-access-copy">
        <Text component="h3" fw={700} size="sm">{message}</Text>
        {error ? <Text c="danger" component="p" size="sm">{error}</Text> : null}
      </div>
      <Group gap="xs" justify="flex-end">
        <Button disabled={pending} loading={pending} onClick={() => act(action)} size="xs" variant="default">{label}</Button>
      </Group>
    </section>
  );
}
