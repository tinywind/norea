import { useRef, useState } from "react";
import { Alert, Group, Loader, NumberInput, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listVpnGateServerVerdicts, setVpnGateServerVerdict, type VpnGateServerVerdictValue } from "../db/queries/vpn-gate-server-verdict";
import { formatDateTimeForLocale, useTranslation, type TranslationKey } from "../i18n";
import { listVpnDownloadProfileIssues, VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY } from "../db/queries/vpn-download-profile-issues";
import { describeError } from "../lib/errors";
import { listSavedPluginVpnProfiles, SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, setSavedPluginVpnProfileLimit } from "../lib/plugin-vpn-profiles";
import { getPluginVpnStatus, PLUGIN_VPN_QUERY_KEY } from "../lib/plugin-vpn";
import { notifyVpnDownloadProfilesChanged, reallowVpnDownloadBatchProfile } from "../lib/tasks/vpn-download-runtime";
import type { VpnDownloadProfileIssueCause } from "../lib/tasks/vpn-download-types";
import { SettingsFieldRow, SettingsInlineControls } from "./SettingsPrimitives";
import { IconButton } from "./IconButton";
import { ConnectIcon, RestartIcon, RetryIcon, SaveIcon, SettingsIcon } from "./ui/icons";
import { ResponsiveSheet } from "./ui/ResponsiveSheet";
import { VpnGateServerVerdictControl } from "./VpnGateServerVerdictControl";

const VERDICT_QUERY_KEY = ["vpn-gate-server-verdicts"] as const;
const CAUSE_KEYS: Record<VpnDownloadProfileIssueCause, TranslationKey> = {
  captcha: "settings.data.pluginVpn.saved.cause.captcha",
  cloudflare: "settings.data.pluginVpn.saved.cause.cloudflare",
  "connection-failed": "settings.data.pluginVpn.saved.cause.connection-failed",
  "authentication-required": "settings.data.pluginVpn.saved.cause.authentication-required",
  "tunnel-lost": "settings.data.pluginVpn.saved.cause.tunnel-lost",
};

interface SavedVpnProfilesSettingsProps {
  /** The saved profile whose connection is starting, shown as busy on its row. */
  connectingProfileId?: string | null;
  disabled?: boolean;
  /** Connects the browsing VPN with a saved profile; the row hides its button without it. */
  onConnect?: (profile: { id: string; hash: string }) => void;
}

export function SavedVpnProfilesSettings({ connectingProfileId = null, disabled = false, onConnect }: SavedVpnProfilesSettingsProps = {}) {
  const { locale, t } = useTranslation();
  const client = useQueryClient();
  const vault = useQuery({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, queryFn: listSavedPluginVpnProfiles, meta: { errorPresentation: "inline" } });
  const verdicts = useQuery({ queryKey: VERDICT_QUERY_KEY, queryFn: listVpnGateServerVerdicts, meta: { errorPresentation: "inline" } });
  const [limitDraft, setLimitDraft] = useState<number | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const issues = useQuery({ queryKey: VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY, queryFn: () => listVpnDownloadProfileIssues(), enabled: opened,
    refetchInterval: opened ? 1000 : false, meta: { errorPresentation: "inline" } });
  const status = useQuery({ queryKey: PLUGIN_VPN_QUERY_KEY, queryFn: getPluginVpnStatus, enabled: opened, refetchInterval: opened ? 1000 : false,
    meta: { errorPresentation: "inline" } });
  const pending = useRef(false);
  const limit = limitDraft ?? vault.data?.limit ?? "";
  const validLimit = typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 100;
  const locked = disabled || busy || vault.isPending || verdicts.isPending || vault.isError || verdicts.isError;
  const savedIps = new Set(vault.data?.profiles.map(profile => profile.ip));
  const missingCount = verdicts.data?.filter(row => row.verdict === "works" && !savedIps.has(row.ip)).length;
  const verdictByIp = new Map(verdicts.data?.map(row => [row.ip, row.verdict]));
  const profileByIp = new Map(vault.data?.profiles.map(profile => [profile.ip, profile]));
  const ips = [...new Set([...(verdicts.data ?? []).map(row => row.ip), ...profileByIp.keys(), ...(issues.data ?? []).map(issue => issue.ip)])].sort();
  const managementLocked = locked || issues.isPending || issues.isError;
  const excludedApprovedIssues = (issues.data ?? []).filter(issue => issue.excluded && verdictByIp.get(issue.ip) === "works");
  const excludedApprovedCount = new Set(excludedApprovedIssues.map(issue => issue.ip)).size;

  async function run(action: () => Promise<void>): Promise<void> {
    if (locked || pending.current) return;
    pending.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await notifyVpnDownloadProfilesChanged();
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY }),
        client.invalidateQueries({ queryKey: VERDICT_QUERY_KEY }),
        client.invalidateQueries({ queryKey: VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY }),
      ]);
      pending.current = false;
      setBusy(false);
    }
  }

  async function changeVerdict(ip: string, verdict: VpnGateServerVerdictValue | null): Promise<void> {
    if (managementLocked || verdict === (verdictByIp.get(ip) ?? null)) return;
    const active = status.data?.profile;
    const source = active?.isVpnGateFinder && active.remoteHost === ip ? { kind: "active" as const, expectedHash: active.hash } : undefined;
    if (verdict === "works" && !source) return;
    await run(async () => {
      const result = source && verdict === "works" ? await setVpnGateServerVerdict(ip, verdict, source) : await setVpnGateServerVerdict(ip, verdict);
      if (result.cleanupError) setActionError(t("settings.data.pluginVpn.saved.cleanupError", { error: result.cleanupError }));
    });
  }

  const loadError = vault.isError || verdicts.isError ? describeError(vault.error ?? verdicts.error) : null;
  const cleanupError = vault.data?.cleanupError ? t("settings.data.pluginVpn.saved.cleanupError", { error: vault.data.cleanupError }) : null;
  const vaultStatus = vault.isPending || verdicts.isPending ? t("settings.data.pluginVpn.saved.loading") : [
    vault.data ? t("settings.data.pluginVpn.saved.count", { count: vault.data.profiles.length, limit: vault.data.limit }) : null,
    vault.data && !verdicts.isError && missingCount !== undefined ? t("settings.data.pluginVpn.saved.missingFiles", { count: missingCount }) : null,
    vault.data?.profiles.length === 0 && !vault.isError ? t("settings.data.pluginVpn.saved.empty") : null,
  ].filter(line => line !== null).join("\n");
  const limitError = limitDraft !== null && !validLimit ? t("settings.data.pluginVpn.saved.invalidLimit") : null;

  return (
    <>
      <SettingsFieldRow label={t("settings.data.pluginVpn.saved.title")} description={t("settings.data.pluginVpn.saved.description")}
        status={vaultStatus || null} error={[loadError, cleanupError].filter(Boolean).join("\n") || undefined}>
        <SettingsInlineControls>
          {loadError ? (
            <IconButton label={t("common.retry")} size="lg" onClick={() => { void Promise.all([vault.refetch(), verdicts.refetch()]); }}>
              <RetryIcon />
            </IconButton>
          ) : null}
          <IconButton label={t("settings.data.pluginVpn.saved.manage")} size="lg" disabled={disabled}
            onClick={() => { setActionError(null); setOpened(true); }}>
            <SettingsIcon />
          </IconButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("settings.data.pluginVpn.saved.limit")}
        error={[limitError, actionError && !opened ? actionError : null].filter(Boolean).join("\n") || undefined}>
        <SettingsInlineControls compact>
          <NumberInput aria-label={t("settings.data.pluginVpn.saved.limit")}
            value={limit} min={1} max={100} allowDecimal={false} allowNegative={false} disabled={locked}
            error={limitError !== null} onChange={setLimitDraft} />
          <IconButton label={t("settings.data.pluginVpn.saved.saveLimit")} size="lg"
            disabled={locked || !validLimit || limit === vault.data?.limit} loading={busy}
            onClick={() => {
              if (!validLimit || limit === vault.data?.limit) return;
              return run(async () => {
                const next = await setSavedPluginVpnProfileLimit(limit);
                client.setQueryData(SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, next);
                setLimitDraft(null);
                if (next.cleanupError) setActionError(t("settings.data.pluginVpn.saved.cleanupError", { error: next.cleanupError }));
              });
            }}><SaveIcon /></IconButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      <ResponsiveSheet busy={busy} closeLabel={t("settings.data.pluginVpn.saved.close")} fullScreenOnPhone
        opened={opened} onClose={() => setOpened(false)} size="lg" title={t("settings.data.pluginVpn.saved.manage")}>
        <Stack gap="md">
          <Text size="sm">{t("settings.data.pluginVpn.saved.managementHelp")}</Text>
          {issues.isPending ? <Text role="status">{t("settings.data.pluginVpn.saved.loading")}</Text> : null}
          {issues.isError ? <Alert color="danger" role="alert">{describeError(issues.error)} <IconButton label={t("common.retry")} size="lg" onClick={() => { void issues.refetch(); }}><RetryIcon /></IconButton></Alert> : null}
          {actionError ? <Alert color="danger" role="alert">{actionError}</Alert> : null}
          <IconButton label={t("settings.data.pluginVpn.saved.reallowAll", { count: excludedApprovedCount })} size="lg"
            disabled={managementLocked || !excludedApprovedCount} loading={busy} onClick={() => {
            if (managementLocked || !excludedApprovedCount) return;
            return run(async () => {
              const results = await Promise.allSettled(excludedApprovedIssues.map(issue =>
                reallowVpnDownloadBatchProfile(issue.batchId, issue.ip, issue.revision)));
              const failures = results.filter(result => result.status === "rejected");
              if (failures.length) throw new Error(t("settings.data.pluginVpn.saved.reallowAllFailed", {
                count: failures.length, error: [...new Set(failures.map(result => describeError(result.reason)))].join("; "),
              }));
            });
          }}><RestartIcon /></IconButton>
          {!managementLocked && !ips.length ? <Text size="sm">{t("settings.data.pluginVpn.saved.noRecords")}</Text> : null}
          {ips.map(ip => {
            const profile = profileByIp.get(ip);
            const verdict = verdictByIp.get(ip) ?? null;
            const active = status.data?.profile;
            const canApprove = active?.isVpnGateFinder === true && active.remoteHost === ip;
            return <Stack key={ip} gap="xs" role="group" aria-label={ip} pb="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <Stack gap={0} style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <Text size="sm" fw="var(--norea-weight-bold)" style={{ overflowWrap: "anywhere" }}>{ip}</Text>
                  {profile ? <Text size="sm" c="dimmed">{t("settings.data.pluginVpn.saved.details", { protocol: profile.protocol.toUpperCase(), date: formatDateTimeForLocale(locale, profile.approvedAt * 1000) })}</Text>
                    : <Text size="sm" c="dimmed">{t("settings.data.pluginVpn.saved.fileUnavailable")}</Text>}
                </Stack>
                <Group gap="xs" wrap="nowrap">
                  <VpnGateServerVerdictControl ip={ip} verdict={verdict} disabled={managementLocked}
                    preferDisabledReason={canApprove ? null : t("settings.data.pluginVpn.saved.approvalUnavailable")}
                    onChange={next => changeVerdict(ip, next)} />
                  {profile && onConnect ? (
                    <IconButton
                      active={connectingProfileId === profile.id}
                      disabled={disabled || connectingProfileId !== null}
                      label={t("settings.data.pluginVpn.saved.connect", { ip })}
                      onClick={() => onConnect({ id: profile.id, hash: profile.hash })}
                      size="lg"
                    >
                      {connectingProfileId === profile.id ? <Loader size={14} /> : <ConnectIcon />}
                    </IconButton>
                  ) : null}
                </Group>
              </Group>
              {(issues.data ?? []).filter(issue => issue.ip === ip).map(issue => <Stack key={issue.batchId} gap={4}>
                <Group justify="space-between" wrap="wrap">
                  <Text size="sm">{t(CAUSE_KEYS[issue.cause])}</Text>
                  <Text size="sm">{t(issue.excluded ? "settings.data.pluginVpn.saved.excluded" : "settings.data.pluginVpn.saved.allowed")}</Text>
                </Group>
                <Text size="sm" c="dimmed">{formatDateTimeForLocale(locale, issue.recordedAt)}</Text>
                <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{t("settings.data.pluginVpn.saved.issueOwner", { batch: issue.batchId, range: issue.rangeId, generation: issue.generation })}</Text>
                {issue.excluded ? <IconButton label={t("settings.data.pluginVpn.saved.reallow")} size="lg" disabled={managementLocked} onClick={() => {
                  if (managementLocked) return;
                  return run(() => reallowVpnDownloadBatchProfile(issue.batchId, ip, issue.revision));
                }}>
                  <RestartIcon />
                </IconButton> : null}
              </Stack>)}
            </Stack>;
          })}
        </Stack>
      </ResponsiveSheet>
    </>
  );
}
