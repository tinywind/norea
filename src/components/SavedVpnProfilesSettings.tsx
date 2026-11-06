import { useRef, useState } from "react";
import { Alert, Checkbox, Group, Loader, NumberInput, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listVpnGateServerVerdicts, setVpnGateServerVerdict, type VpnGateServerVerdictValue } from "../db/queries/vpn-gate-server-verdict";
import { formatDateTimeForLocale, useTranslation, type TranslationKey } from "../i18n";
import { listVpnDownloadProfileIssues, VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY } from "../db/queries/vpn-download-profile-issues";
import { describeError } from "../lib/errors";
import { listManualPluginVpnProfiles, listSavedPluginVpnProfiles, MANUAL_PLUGIN_VPN_PROFILES_QUERY_KEY, SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, setSavedPluginVpnProfileLimit } from "../lib/plugin-vpn-profiles";
import { getPluginVpnStatus, PLUGIN_VPN_QUERY_KEY } from "../lib/plugin-vpn";
import { notifyVpnDownloadProfilesChanged, reallowVpnDownloadBatchProfile } from "../lib/tasks/vpn-download-runtime";
import type { VpnDownloadProfileIssueCause } from "../lib/tasks/vpn-download-types";
import type { PluginVpnUrlTestOutcome, PluginVpnUrlTestTarget } from "../lib/plugin-vpn-url-test";
import { usePluginVpnUrlTestStore } from "../store/plugin-vpn-url-test";
import { ChipButton } from "./ChipButton";
import { SettingsFieldRow, SettingsInlineControls } from "./SettingsPrimitives";
import { IconButton } from "./IconButton";
import { PluginVpnSelectionPanel, PluginVpnUrlTestStatus } from "./PluginVpnSelectionPanel";
import { showSettingsToast } from "./settings/settings-toast";
import { ConnectIcon, ExcludeIcon, PreferIcon, RestartIcon, RetryIcon, SaveIcon, SelectIcon, SettingsIcon } from "./ui/icons";
import { ResponsiveSheet } from "./ui/ResponsiveSheet";
import { SelectionAction } from "./ui/SelectionBar";
import { VpnGateServerVerdictControl } from "./VpnGateServerVerdictControl";

const VERDICT_QUERY_KEY = ["vpn-gate-server-verdicts"] as const;
const CAUSE_KEYS: Record<VpnDownloadProfileIssueCause, TranslationKey> = {
  captcha: "settings.data.pluginVpn.saved.cause.captcha",
  cloudflare: "settings.data.pluginVpn.saved.cause.cloudflare",
  "connection-failed": "settings.data.pluginVpn.saved.cause.connection-failed",
  "authentication-required": "settings.data.pluginVpn.saved.cause.authentication-required",
  "tunnel-lost": "settings.data.pluginVpn.saved.cause.tunnel-lost",
  "page-unresponsive": "settings.data.pluginVpn.saved.cause.page-unresponsive",
  "site-forbidden": "settings.data.pluginVpn.saved.cause.site-forbidden",
};
const RECENT_ISSUES_PER_PROFILE = 3;
const CONNECTION_FAILURE_CAUSES: ReadonlySet<VpnDownloadProfileIssueCause> = new Set(["connection-failed", "authentication-required", "tunnel-lost", "page-unresponsive"]);
const CONNECTION_FAILURE_TESTS: ReadonlySet<PluginVpnUrlTestOutcome["kind"]> = new Set(["connectionFailed", "requestFailed", "timedOut"]);

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
  const manual = useQuery({ queryKey: MANUAL_PLUGIN_VPN_PROFILES_QUERY_KEY, queryFn: listManualPluginVpnProfiles, meta: { errorPresentation: "inline" } });
  const verdicts = useQuery({ queryKey: VERDICT_QUERY_KEY, queryFn: listVpnGateServerVerdicts, meta: { errorPresentation: "inline" } });
  const [limitDraft, setLimitDraft] = useState<number | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIps, setSelectedIps] = useState<ReadonlySet<string>>(new Set());
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [blockedOpened, setBlockedOpened] = useState(false);
  const urlTestResults = usePluginVpnUrlTestStore(state => state.results);
  const issues = useQuery({ queryKey: VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY, queryFn: () => listVpnDownloadProfileIssues(), enabled: opened,
    refetchInterval: opened ? 1000 : false, meta: { errorPresentation: "inline" } });
  const status = useQuery({ queryKey: PLUGIN_VPN_QUERY_KEY, queryFn: getPluginVpnStatus, enabled: opened, refetchInterval: opened ? 1000 : false,
    meta: { errorPresentation: "inline" } });
  const pending = useRef(false);
  const limit = limitDraft ?? vault.data?.limit ?? "";
  const validLimit = typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 100;
  const locked = disabled || busy || vault.isPending || verdicts.isPending || vault.isError || verdicts.isError;
  const manualByHost = new Map(manual.data?.map(profile => [profile.host, profile]));
  const savedIps = new Set([...(vault.data?.profiles.map(profile => profile.ip) ?? []), ...manualByHost.keys()]);
  const verdictByIp = new Map(verdicts.data?.map(row => [row.ip, row.verdict]));
  const profileByIp = new Map(vault.data?.profiles.map(profile => [profile.ip, profile]));
  const hasConnectionFailure = (ip: string) =>
    (issues.data ?? []).some(issue => issue.ip === ip && CONNECTION_FAILURE_CAUSES.has(issue.cause)) ||
    CONNECTION_FAILURE_TESTS.has(urlTestResults[ip]?.outcome.kind ?? "ok");
  // Only profiles with a saved file are managed here; a server marked Not used keeps no file.
  const savedProfileIps = [...savedIps].sort();
  const ips = savedProfileIps.filter(ip => !failuresOnly || hasConnectionFailure(ip));
  const blockedServers = (verdicts.data ?? []).filter(row => row.verdict === "fails" && !savedIps.has(row.ip));
  const managementLocked = locked || issues.isPending || issues.isError;
  const excludedApprovedIssues = (issues.data ?? []).filter(issue => issue.excluded && savedIps.has(issue.ip));
  const excludedApprovedCount = new Set(excludedApprovedIssues.map(issue => issue.ip)).size;
  const selected = ips.filter(ip => selectedIps.has(ip));
  const testTargets = selected.flatMap((ip): PluginVpnUrlTestTarget[] => {
    const profile = profileByIp.get(ip);
    if (profile) return [{ host: ip, profile: { kind: "saved", id: profile.id, expectedHash: profile.hash } }];
    const manualProfile = manualByHost.get(ip);
    return manualProfile ? [{ host: ip, profile: { kind: "manual", host: ip, expectedHash: manualProfile.hash } }] : [];
  });
  const preferTargets = selected.filter(ip => verdictByIp.get(ip) !== "works");
  const blockTargets = selected.filter(ip => verdictByIp.get(ip) !== "fails");

  function exitSelection(): void {
    setSelectionMode(false);
    setSelectedIps(new Set());
  }

  function toggleSelected(ip: string): void {
    setSelectedIps(current => {
      const next = new Set(current);
      if (next.has(ip)) next.delete(ip);
      else next.add(ip);
      return next;
    });
  }

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
    const source = active?.remoteHost === ip ? { kind: "active" as const, expectedHash: active.hash } : undefined;
    if (verdict === "works" && !source) return;
    await run(async () => {
      const result = source && verdict === "works" ? await setVpnGateServerVerdict(ip, verdict, source) : await setVpnGateServerVerdict(ip, verdict);
      if (result.cleanupError) setActionError(t("settings.data.pluginVpn.saved.cleanupError", { error: result.cleanupError }));
    });
  }

  async function unblock(ip: string): Promise<void> {
    await run(async () => {
      const result = await setVpnGateServerVerdict(ip, null);
      if (result.cleanupError) setActionError(t("settings.data.pluginVpn.saved.cleanupError", { error: result.cleanupError }));
    });
  }

  /** Preferred needs an exact profile, which only the connected server can provide here. */
  async function preferSelected(): Promise<void> {
    if (managementLocked || !preferTargets.length) return;
    const active = status.data?.profile;
    const source = active ? { kind: "active" as const, expectedHash: active.hash } : null;
    const capturable = source ? preferTargets.filter(ip => ip === active?.remoteHost) : [];
    const skipped = preferTargets.length - capturable.length;
    await run(async () => {
      const cleanupErrors: string[] = [];
      if (source) {
        for (const ip of capturable) {
          const result = await setVpnGateServerVerdict(ip, "works", source);
          if (result.cleanupError) cleanupErrors.push(result.cleanupError);
        }
      }
      if (capturable.length) showSettingsToast("ok", t("settings.data.pluginVpn.selection.preferred", { count: capturable.length }));
      if (skipped) showSettingsToast("info", t("settings.data.pluginVpn.selection.preferSkipped", { count: skipped }));
      if (cleanupErrors.length) setActionError(t("settings.data.pluginVpn.saved.cleanupError", { error: cleanupErrors.join("; ") }));
    });
  }

  async function blockSelected(): Promise<void> {
    if (managementLocked || !blockTargets.length) return;
    await run(async () => {
      const failures: string[] = [];
      const cleanupErrors: string[] = [];
      for (const ip of blockTargets) {
        try {
          const result = await setVpnGateServerVerdict(ip, "fails");
          if (result.cleanupError) cleanupErrors.push(result.cleanupError);
        } catch (error) {
          failures.push(`${ip}: ${describeError(error)}`);
        }
      }
      const blocked = blockTargets.length - failures.length;
      if (blocked) showSettingsToast("ok", t("settings.data.pluginVpn.selection.blocked", { count: blocked }));
      if (failures.length) throw new Error(t("settings.data.pluginVpn.selection.blockFailed", { count: failures.length, error: failures.join("; ") }));
      if (cleanupErrors.length) setActionError(t("settings.data.pluginVpn.saved.cleanupError", { error: cleanupErrors.join("; ") }));
    });
  }

  const loadError = vault.isError || verdicts.isError || manual.isError ? describeError(vault.error ?? verdicts.error ?? manual.error) : null;
  const cleanupError = vault.data?.cleanupError ? t("settings.data.pluginVpn.saved.cleanupError", { error: vault.data.cleanupError }) : null;
  const vaultStatus = vault.isPending || verdicts.isPending ? t("settings.data.pluginVpn.saved.loading") : [
    vault.data ? t("settings.data.pluginVpn.saved.count", { count: vault.data.profiles.length, limit: vault.data.limit }) : null,
    manualByHost.size ? t("settings.data.pluginVpn.saved.manualCount", { count: manualByHost.size }) : null,
    vault.data?.profiles.length === 0 && !manualByHost.size && !vault.isError ? t("settings.data.pluginVpn.saved.empty") : null,
  ].filter(line => line !== null).join("\n");
  const limitError = limitDraft !== null && !validLimit ? t("settings.data.pluginVpn.saved.invalidLimit") : null;

  return (
    <>
      <SettingsFieldRow label={t("settings.data.pluginVpn.saved.title")} description={t("settings.data.pluginVpn.saved.description")}
        status={vaultStatus || null} error={[loadError, cleanupError].filter(Boolean).join("\n") || undefined}>
        <SettingsInlineControls>
          {loadError ? (
            <IconButton label={t("common.retry")} size="lg" onClick={() => { void Promise.all([vault.refetch(), verdicts.refetch(), manual.refetch()]); }}>
              <RetryIcon />
            </IconButton>
          ) : null}
          <IconButton label={t("settings.data.pluginVpn.saved.manage")} size="lg" disabled={disabled}
            onClick={() => { setActionError(null); setOpened(true); }}>
            <SettingsIcon />
          </IconButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("settings.data.pluginVpn.blocked.title")} description={t("settings.data.pluginVpn.blocked.description")}
        status={verdicts.data ? t("settings.data.pluginVpn.blocked.count", { count: blockedServers.length }) : null}>
        <SettingsInlineControls>
          <IconButton label={t("settings.data.pluginVpn.blocked.manage")} size="lg" disabled={disabled || !verdicts.data}
            onClick={() => { setActionError(null); setBlockedOpened(true); }}>
            <ExcludeIcon />
          </IconButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("settings.data.pluginVpn.saved.limit")}
        error={[limitError, actionError && !opened && !blockedOpened ? actionError : null].filter(Boolean).join("\n") || undefined}>
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
        opened={opened} onClose={() => { exitSelection(); setOpened(false); }} size="lg" title={t("settings.data.pluginVpn.saved.manage")}>
        <Stack gap="md">
          <Text size="sm">{t("settings.data.pluginVpn.saved.managementHelp")}</Text>
          {issues.isPending ? <Text role="status">{t("settings.data.pluginVpn.saved.loading")}</Text> : null}
          {issues.isError ? <Alert color="danger" role="alert">{describeError(issues.error)} <IconButton label={t("common.retry")} size="lg" onClick={() => { void issues.refetch(); }}><RetryIcon /></IconButton></Alert> : null}
          {actionError ? <Alert color="danger" role="alert">{actionError}</Alert> : null}
          <Group justify="space-between" wrap="nowrap">
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
            <IconButton active={selectionMode} disabled={!ips.length} label={t("library.selection.start")} size="lg"
              onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}>
              <SelectIcon />
            </IconButton>
          </Group>
          <Group gap="xs" role="group" aria-label={t("settings.data.pluginVpn.saved.filter.label")}>
            <ChipButton disabled={!savedProfileIps.length} selected={failuresOnly} onClick={() => setFailuresOnly(!failuresOnly)}>
              {t("settings.data.pluginVpn.saved.filter.failures")}
            </ChipButton>
          </Group>
          {selectionMode ? (
            <PluginVpnSelectionPanel
              actions={<>
                <SelectionAction disabled={managementLocked || !preferTargets.length} icon={PreferIcon}
                  label={t("settings.data.pluginVpn.finder.verdict.prefer")} onClick={() => preferSelected()} />
                <SelectionAction disabled={managementLocked || !blockTargets.length} icon={ExcludeIcon}
                  label={t("settings.data.pluginVpn.finder.verdict.block")} onClick={() => blockSelected()} />
              </>}
              allSelected={ips.length > 0 && selected.length === ips.length}
              count={selected.length}
              onDeselectAll={() => setSelectedIps(new Set())}
              onExit={exitSelection}
              onSelectAll={() => setSelectedIps(new Set(ips))}
              selectAllDisabled={!ips.length}
              testTargets={testTargets}
              untestableCount={selected.length - testTargets.length}
            />
          ) : null}
          {!managementLocked && !savedProfileIps.length ? <Text size="sm">{t("settings.data.pluginVpn.saved.noRecords")}</Text> : null}
          {!managementLocked && savedProfileIps.length > 0 && !ips.length ? <Text size="sm">{t("settings.data.pluginVpn.saved.noFilterMatches")}</Text> : null}
          {ips.map(ip => {
            const profile = profileByIp.get(ip);
            const manualProfile = manualByHost.get(ip);
            const verdict = verdictByIp.get(ip) ?? null;
            const canApprove = status.data?.profile?.remoteHost === ip;
            return <Stack key={ip} gap="xs" role="group" aria-label={ip} pb="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
              <Group justify="space-between" align="flex-start" wrap="wrap">
                {selectionMode ? <Checkbox aria-label={t("settings.data.pluginVpn.selection.select", { ip })} checked={selectedIps.has(ip)}
                  onChange={() => toggleSelected(ip)} radius="xl" size="md" /> : null}
                <Stack gap={0} style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <Text size="sm" fw="var(--norea-weight-bold)" style={{ overflowWrap: "anywhere" }}>{ip}</Text>
                  {profile ? <Text size="sm" c="dimmed">{t("settings.data.pluginVpn.saved.details", { protocol: profile.protocol.toUpperCase(), date: formatDateTimeForLocale(locale, profile.approvedAt * 1000) })}</Text>
                    : manualProfile ? <Text size="sm" c="dimmed">{t("settings.data.pluginVpn.saved.manualDetails", { date: formatDateTimeForLocale(locale, manualProfile.savedAt * 1000) })}</Text>
                    : null}
                  <PluginVpnUrlTestStatus host={ip} />
                </Stack>
                <Group gap="xs" wrap="nowrap">
                  <VpnGateServerVerdictControl blockable={false} ip={ip} verdict={verdict} disabled={managementLocked}
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
              {(issues.data ?? []).filter(issue => issue.ip === ip).sort((left, right) => right.recordedAt - left.recordedAt)
                .slice(0, RECENT_ISSUES_PER_PROFILE).map(issue => <Stack key={issue.batchId} gap={4}>
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
      <ResponsiveSheet busy={busy} closeLabel={t("settings.data.pluginVpn.blocked.close")} fullScreenOnPhone
        opened={blockedOpened} onClose={() => setBlockedOpened(false)} size="lg" title={t("settings.data.pluginVpn.blocked.title")}>
        <Stack gap="md">
          <Text size="sm">{t("settings.data.pluginVpn.blocked.description")}</Text>
          {actionError ? <Alert color="danger" role="alert">{actionError}</Alert> : null}
          {!blockedServers.length ? <Text size="sm">{t("settings.data.pluginVpn.blocked.empty")}</Text> : null}
          {blockedServers.map(row => (
            <Group key={row.ip} justify="space-between" wrap="nowrap" pb="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
              <Stack gap={0} style={{ minWidth: 0, flex: "1 1 auto" }}>
                <Text size="sm" fw="var(--norea-weight-bold)" style={{ overflowWrap: "anywhere" }}>{row.ip}</Text>
                <Text size="sm" c="dimmed">{t("settings.data.pluginVpn.blocked.since", { date: formatDateTimeForLocale(locale, row.updatedAt * 1000) })}</Text>
              </Stack>
              <IconButton label={t("settings.data.pluginVpn.blocked.unblock", { ip: row.ip })} size="lg" disabled={locked} loading={busy}
                onClick={() => unblock(row.ip)}>
                <RestartIcon />
              </IconButton>
            </Group>
          ))}
        </Stack>
      </ResponsiveSheet>
    </>
  );
}
