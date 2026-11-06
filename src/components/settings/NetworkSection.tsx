import { useRef, useState } from "react";
import { PasswordInput, Switch, Text, TextInput } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PluginVpnFinder, pluginVpnFinderVerdictCaptureSource } from "../PluginVpnFinder";
import { SavedVpnProfilesSettings } from "../SavedVpnProfilesSettings";
import { TestedVpnServers } from "../TestedVpnServers";
import {
  SettingsAdvancedGroup,
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
  SettingsWideField,
} from "../SettingsPrimitives";
import { IconButton } from "../IconButton";
import { useConfirm } from "../ui/ConfirmDialog";
import {
  ImportIcon,
  RetryIcon,
  SearchIcon,
  TrashIcon,
} from "../ui/icons";
import { VpnGateServerVerdictControl } from "../VpnGateServerVerdictControl";
import {
  listVpnGateServerVerdicts,
  setVpnGateServerVerdict,
  type VpnGateServerVerdict,
  type VpnGateServerVerdictValue,
} from "../../db/queries/vpn-gate-server-verdict";
import { describeError } from "../../lib/errors";
import { useNetworkStore } from "../../lib/network";
import {
  canStartPluginVpnConnection,
  connectPluginVpn,
  disconnectPluginVpn,
  getPluginVpnStatus,
  importPluginVpnProfile,
  PLUGIN_VPN_QUERY_KEY,
  removePluginVpnProfile,
  switchPluginVpnFinderServer,
  switchPluginVpnSavedProfile,
  PluginVpnConnectionNotEstablishedError,
  type PluginVpnFinderServer,
  type PluginVpnFinderSwitchLifecycle,
  type PluginVpnCredentials,
  type PluginVpnPhase,
  type PluginVpnProfile,
  type PluginVpnStatus,
} from "../../lib/plugin-vpn";
import {
  captureSavedPluginVpnProfile,
  SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY,
  type SavedVpnProfileCaptureSource,
} from "../../lib/plugin-vpn-profiles";
import { useTranslation, type TranslationKey } from "../../i18n";
import { usePluginVpnStore } from "../../store/plugin-vpn";
import { showSettingsToast } from "./settings-toast";

function emptyPluginVpnCredentials(): PluginVpnCredentials {
  return {
    challengeResponse: "",
    password: "",
    privateKeyPassword: "",
    username: "",
  };
}

const PLUGIN_VPN_PHASE_KEYS: Record<PluginVpnPhase, TranslationKey> = {
  waitingForNetwork: "settings.data.pluginVpn.status.waitingForNetwork",
  connected: "settings.data.pluginVpn.status.connected",
  connecting: "settings.data.pluginVpn.status.connecting",
  disabled: "settings.data.pluginVpn.status.disabled",
  disconnecting: "settings.data.pluginVpn.status.disconnecting",
  error: "settings.data.pluginVpn.status.error",
  reconnecting: "settings.data.pluginVpn.status.reconnecting",
};
const VPN_GATE_SERVER_VERDICTS_QUERY_KEY = [
  "vpn-gate-server-verdicts",
] as const;

type PluginVpnOperation =
  | { kind: "connect" }
  | { kind: "disconnect" }
  | {
      candidateId: string;
      kind: "finder" | "saved";
      phase: "connecting" | "disconnecting";
    }
  | { kind: "import" }
  | { kind: "remove" };

export function NetworkSection({ isBusy }: { isBusy: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const vpnEnabled = usePluginVpnStore((state) => state.enabled);
  const online = useNetworkStore((state) => state.connectivity === "online");
  const [finderOpen, setFinderOpen] = useState(false);
  const [vpnOperation, setVpnOperation] = useState<PluginVpnOperation | null>(
    null,
  );
  const [credentials, setCredentials] = useState<PluginVpnCredentials>(
    emptyPluginVpnCredentials,
  );
  const [verdictSavingIps, setVerdictSavingIps] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const connectionRequest = useRef(0);
  const verdictSavingIpsRef = useRef(new Set<string>());
  const verdictQuery = useQuery({
    meta: { errorPresentation: "inline" },
    queryFn: listVpnGateServerVerdicts,
    queryKey: VPN_GATE_SERVER_VERDICTS_QUERY_KEY,
  });
  const vpnQuery = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: PLUGIN_VPN_QUERY_KEY,
    queryFn: getPluginVpnStatus,
    refetchInterval: (query) => {
      const phase = (query.state.data as PluginVpnStatus | undefined)?.phase;
      const localConnectionActive =
        vpnOperation?.kind === "connect" ||
        vpnOperation?.kind === "disconnect" ||
        vpnOperation?.kind === "finder" ||
        vpnOperation?.kind === "saved";
      return vpnEnabled ||
        localConnectionActive ||
        phase === "connecting" ||
        phase === "connected" ||
        phase === "reconnecting" ||
        phase === "disconnecting"
        ? 2_000
        : false;
    },
  });
  const status = vpnQuery.data;
  const currentProfileHost = status?.profile?.remoteHost ?? null;
  const verdicts = new Map(
    (verdictQuery.data ?? []).map((row) => [row.ip, row.verdict]),
  );
  const localPhase: PluginVpnPhase | undefined =
    vpnOperation?.kind === "connect"
      ? "connecting"
      : vpnOperation?.kind === "disconnect"
        ? "disconnecting"
        : vpnOperation?.kind === "finder" || vpnOperation?.kind === "saved"
          ? vpnOperation.phase
          : undefined;
  const displayPhase = vpnEnabled && !online ? "waitingForNetwork" : localPhase ?? (
    vpnEnabled && status?.phase === "disabled" && status.error
      ? "error"
      : status?.phase
  );
  const statusAvailable = status !== undefined;
  const disconnected = status?.phase === "disabled";
  const profileOperationActive =
    vpnOperation?.kind === "import" || vpnOperation?.kind === "remove";
  const profileControlsDisabled =
    isBusy || vpnOperation !== null || !statusAvailable;
  const finderDisabled = isBusy || profileOperationActive || !statusAvailable;
  const finderDisabledReason = !statusAvailable
    ? vpnQuery.isError
      ? t("common.loadFailed")
      : t("settings.data.pluginVpn.status.loading")
    : isBusy || profileOperationActive
      ? t("settings.data.pluginVpn.finder.status.controlsUnavailable")
      : null;
  const verdictControlsDisabled =
    isBusy || verdictQuery.isPending || verdictQuery.isError;
  const verdictDisabledReason = isBusy
    ? t("settings.data.pluginVpn.finder.status.controlsUnavailable")
    : verdictQuery.isPending
      ? t("settings.data.pluginVpn.status.loading")
      : verdictQuery.isError
        ? t("common.loadFailed")
        : null;
  const canConnect =
    !isBusy &&
    vpnOperation === null &&
    canStartPluginVpnConnection(status, credentials);
  const connectionRequestActive =
    vpnOperation?.kind === "connect" || vpnOperation?.kind === "finder" || vpnOperation?.kind === "saved";
  const showConnectionStop =
    vpnEnabled ||
    connectionRequestActive ||
    vpnOperation?.kind === "disconnect" ||
    (status !== undefined && status.phase !== "disabled");
  const visibleStatusError =
    vpnEnabled && online && vpnOperation === null ? status?.error ?? null : null;

  function updateStatus(nextStatus: PluginVpnStatus): void {
    queryClient.setQueryData(PLUGIN_VPN_QUERY_KEY, nextStatus);
  }

  function updateVerdictSavingState(ip: string, saving: boolean): void {
    if (saving) {
      verdictSavingIpsRef.current.add(ip);
    } else {
      verdictSavingIpsRef.current.delete(ip);
    }
    setVerdictSavingIps(new Set(verdictSavingIpsRef.current));
  }

  async function updateServerVerdict(
    ip: string,
    verdict: VpnGateServerVerdictValue | null,
    source?: SavedVpnProfileCaptureSource,
  ): Promise<void> {
    const error = await saveServerVerdict(ip, verdict, source);
    if (error === null) return;
    showSettingsToast(
      "danger",
      t("settings.data.pluginVpn.title"),
      t("settings.data.pluginVpn.finder.verdict.saveFailed", { error }),
    );
  }

  /** Saves one verdict; resolves to the failure message, or null when it was saved or skipped. */
  async function saveServerVerdict(
    ip: string,
    verdict: VpnGateServerVerdictValue | null,
    source?: SavedVpnProfileCaptureSource,
  ): Promise<string | null> {
    if (
      verdictControlsDisabled ||
      verdictSavingIpsRef.current.has(ip)
    ) {
      return null;
    }

    updateVerdictSavingState(ip, true);
    try {
      const result = await setVpnGateServerVerdict(ip, verdict, source);
      queryClient.setQueryData<VpnGateServerVerdict[]>(
        VPN_GATE_SERVER_VERDICTS_QUERY_KEY,
        (current = []) => {
          const next = current.filter((row) => row.ip !== ip);
          if (result.verdict !== null) next.push(result.verdict);
          return next.sort((left, right) => left.ip.localeCompare(right.ip));
        },
      );
      return result.cleanupError;
    } catch (error) {
      return describeError(error);
    } finally {
      void queryClient.invalidateQueries({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: VPN_GATE_SERVER_VERDICTS_QUERY_KEY });
      updateVerdictSavingState(ip, false);
    }
  }

  /** Finder bulk action: captures each server's exact profile in turn, as its Preferred toggle does. */
  async function addFinderServersToPreferred(
    servers: readonly PluginVpnFinderServer[],
  ): Promise<void> {
    const failures: string[] = [];
    for (const server of servers) {
      const error = await saveServerVerdict(
        server.ip,
        "works",
        pluginVpnFinderVerdictCaptureSource(server),
      );
      if (error !== null) failures.push(`${server.ip}: ${error}`);
    }
    const saved = servers.length - failures.length;
    if (saved > 0) {
      showSettingsToast("ok", t("settings.data.pluginVpn.selection.preferred", { count: saved }));
    }
    if (failures.length > 0) {
      showSettingsToast(
        "danger",
        t("settings.data.pluginVpn.title"),
        t("settings.data.pluginVpn.selection.preferFailed", {
          count: failures.length,
          error: failures.join("; "),
        }),
      );
    }
  }

  function isCurrentConnectionRequest(request: number): boolean {
    return connectionRequest.current === request;
  }

  function describeConnectionError(error: unknown): string {
    return error instanceof PluginVpnConnectionNotEstablishedError
      ? t("settings.data.pluginVpn.connection.notEstablished")
      : describeError(error);
  }

  async function importProfile(): Promise<void> {
    setVpnOperation({ kind: "import" });
    try {
      const nextStatus = await importPluginVpnProfile();
      if (nextStatus) {
        setCredentials(emptyPluginVpnCredentials());
        updateStatus(nextStatus);
        showSettingsToast(
          "ok",
          t("settings.data.pluginVpn.title"),
          t("settings.data.pluginVpn.toast.imported"),
        );
        if (nextStatus.profile) await saveImportedProfile(nextStatus.profile);
      }
    } catch (error) {
      showSettingsToast(
        "danger",
        t("settings.data.pluginVpn.title"),
        describeError(error),
      );
    } finally {
      await vpnQuery.refetch();
      setVpnOperation(null);
    }
  }

  /** Keeps an imported profile in the saved list and the storage folder, added to Preferred. */
  async function saveImportedProfile(profile: PluginVpnProfile): Promise<void> {
    try {
      const result = await captureSavedPluginVpnProfile(profile.remoteHost, {
        kind: "active",
        expectedHash: profile.hash,
      });
      if (result.cleanupError) throw new Error(result.cleanupError);
    } catch (error) {
      showSettingsToast(
        "danger",
        t("settings.data.pluginVpn.title"),
        t("settings.data.pluginVpn.toast.importSaveFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      void queryClient.invalidateQueries({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: VPN_GATE_SERVER_VERDICTS_QUERY_KEY });
    }
  }

  async function removeProfile(): Promise<void> {
    const confirmed = await confirm({
      title: t("settings.data.pluginVpn.profile.remove"),
      message: t("settings.data.pluginVpn.profile.removeConfirm"),
      confirmLabel: t("settings.data.pluginVpn.profile.remove"),
      danger: true,
    });
    if (!confirmed) return;
    setVpnOperation({ kind: "remove" });
    try {
      updateStatus(await removePluginVpnProfile());
      setCredentials(emptyPluginVpnCredentials());
      showSettingsToast(
        "ok",
        t("settings.data.pluginVpn.title"),
        t("settings.data.pluginVpn.toast.removed"),
      );
    } catch (error) {
      showSettingsToast(
        "danger",
        t("settings.data.pluginVpn.title"),
        describeError(error),
      );
    } finally {
      await vpnQuery.refetch();
      setVpnOperation(null);
    }
  }

  function applyAndConnectFinderServer(candidateId: string): Promise<void> {
    return switchAndConnect(candidateId, "finder", (lifecycle) => switchPluginVpnFinderServer(candidateId, lifecycle));
  }

  function connectSavedProfile(profile: { id: string; hash: string }): Promise<void> {
    return switchAndConnect(profile.id, "saved", (lifecycle) => switchPluginVpnSavedProfile(profile, lifecycle));
  }

  async function switchAndConnect(
    candidateId: string,
    kind: "finder" | "saved",
    switchProfile: (lifecycle: PluginVpnFinderSwitchLifecycle) => Promise<PluginVpnStatus | null>,
  ): Promise<void> {
    if (finderDisabled) return;
    const request = ++connectionRequest.current;
    setCredentials(emptyPluginVpnCredentials());
    setVpnOperation({ candidateId, kind, phase: "disconnecting" });
    try {
      const nextStatus = await switchProfile({
        isCurrent: () => isCurrentConnectionRequest(request),
        onConnecting: () => {
          if (isCurrentConnectionRequest(request)) {
            setVpnOperation({ candidateId, kind, phase: "connecting" });
          }
        },
      });
      if (!nextStatus || !isCurrentConnectionRequest(request)) return;
      updateStatus(nextStatus);
      showSettingsToast(
        "ok",
        t("settings.data.pluginVpn.title"),
        t("settings.data.pluginVpn.finder.toast.connected"),
      );
    } catch (error) {
      if (isCurrentConnectionRequest(request)) {
        showSettingsToast(
          "danger",
          t("settings.data.pluginVpn.title"),
          describeConnectionError(error),
        );
      }
    } finally {
      if (isCurrentConnectionRequest(request)) {
        await vpnQuery.refetch();
        if (isCurrentConnectionRequest(request)) setVpnOperation(null);
      }
    }
  }

  async function connect(): Promise<void> {
    if (!canConnect) return;
    const request = ++connectionRequest.current;
    const submitted = { ...credentials };
    setVpnOperation({ kind: "connect" });
    try {
      const nextStatus = await connectPluginVpn(submitted, () =>
        isCurrentConnectionRequest(request),
      );
      if (!nextStatus || !isCurrentConnectionRequest(request)) return;
      updateStatus(nextStatus);
      setCredentials(emptyPluginVpnCredentials());
      showSettingsToast(
        "ok",
        t("settings.data.pluginVpn.title"),
        t("settings.data.pluginVpn.toast.connected"),
      );
    } catch (error) {
      if (isCurrentConnectionRequest(request)) {
        showSettingsToast(
          "danger",
          t("settings.data.pluginVpn.title"),
          describeConnectionError(error),
        );
      }
    } finally {
      if (isCurrentConnectionRequest(request)) {
        await vpnQuery.refetch();
        if (isCurrentConnectionRequest(request)) setVpnOperation(null);
      }
    }
  }

  async function disconnect(): Promise<void> {
    const request = ++connectionRequest.current;
    setVpnOperation({ kind: "disconnect" });
    try {
      const nextStatus = await disconnectPluginVpn();
      if (!isCurrentConnectionRequest(request)) return;
      updateStatus(nextStatus);
      showSettingsToast(
        "ok",
        t("settings.data.pluginVpn.title"),
        t("settings.data.pluginVpn.toast.disconnected"),
      );
    } catch (error) {
      if (isCurrentConnectionRequest(request)) {
        showSettingsToast(
          "danger",
          t("settings.data.pluginVpn.title"),
          describeError(error),
        );
      }
    } finally {
      if (isCurrentConnectionRequest(request)) {
        await vpnQuery.refetch();
        if (isCurrentConnectionRequest(request)) setVpnOperation(null);
      }
    }
  }

  // One status, one action: stop while a connection is up or in progress, otherwise connect.
  const stopAction = showConnectionStop && !(disconnected && vpnOperation === null);
  const stopDisabled =
    profileOperationActive ||
    vpnOperation?.kind === "disconnect" ||
    (!vpnEnabled && !connectionRequestActive && !statusAvailable);

  return (
    <SettingsSection title={t("settings.data.pluginVpn.title")}>
      {!vpnQuery.isError && status?.supported === false ? (
        <Text>{t("settings.data.pluginVpn.unsupported")}</Text>
      ) : (
        <>
          <SettingsFieldRow
            label={t("settings.data.pluginVpn.connection.label")}
            description={t("settings.data.pluginVpn.connection.description")}
            status={vpnQuery.isError
              ? null
              : displayPhase
                ? t(PLUGIN_VPN_PHASE_KEYS[displayPhase])
                : t("settings.data.pluginVpn.status.loading")}
            error={vpnQuery.isError ? t("common.loadFailed") : visibleStatusError}
          >
            {vpnQuery.isError ? (
              <IconButton
                label={t("common.retry")}
                size="lg"
                loading={vpnQuery.isFetching}
                onClick={() => {
                  void vpnQuery.refetch();
                }}
              >
                <RetryIcon />
              </IconButton>
            ) : (
              <Switch
                aria-label={t("settings.data.pluginVpn.connection.label")}
                checked={stopAction && vpnOperation?.kind !== "disconnect"}
                disabled={stopAction ? stopDisabled : !canConnect}
                onChange={(event) => {
                  if (event.currentTarget.checked) void connect();
                  else void disconnect();
                }}
              />
            )}
          </SettingsFieldRow>
          <SettingsFieldRow
            label={t("settings.data.pluginVpn.profile.label")}
            description={currentProfileHost
              ? `${t("settings.data.pluginVpn.profile.description")} ${t("settings.data.pluginVpn.finder.verdict.description")}`
              : t("settings.data.pluginVpn.profile.description")}
            layout="stacked"
          >
            <SettingsInlineControls>
              <div className="norea-settings-path-value norea-settings-profile-host">
                <span className="norea-settings-profile-host-text">
                  {status?.profile?.remoteHost ??
                    t("settings.data.pluginVpn.profile.empty")}
                </span>
                {currentProfileHost ? (
                  <VpnGateServerVerdictControl
                    size="sm"
                    disabled={
                      verdictControlsDisabled ||
                      verdictSavingIps.has(currentProfileHost)
                    }
                    disabledReason={
                      verdictSavingIps.has(currentProfileHost)
                        ? t("settings.data.pluginVpn.finder.verdict.saving")
                        : verdictDisabledReason
                    }
                    ip={currentProfileHost}
                    onChange={(verdict) =>
                      updateServerVerdict(
                        currentProfileHost,
                        verdict,
                        status?.profile
                          ? { kind: "active", expectedHash: status.profile.hash }
                          : undefined,
                      )
                    }
                    verdict={verdicts.get(currentProfileHost) ?? null}
                  />
                ) : null}
              </div>
              <div className="norea-settings-profile-actions">
                <IconButton
                  disabled={profileControlsDisabled}
                  label={status?.profile
                    ? t("settings.data.pluginVpn.profile.replace")
                    : t("settings.data.pluginVpn.profile.import")}
                  loading={vpnOperation?.kind === "import"}
                  onClick={() => {
                    void importProfile();
                  }}
                  size="lg"
                >
                  <ImportIcon />
                </IconButton>
                <IconButton
                  disabled={finderDisabled}
                  label={t("settings.data.pluginVpn.finder.open")}
                  onClick={() => setFinderOpen(true)}
                  size="lg"
                >
                  <SearchIcon />
                </IconButton>
                {status?.profile ? (
                  <IconButton
                    disabled={profileControlsDisabled}
                    label={t("settings.data.pluginVpn.profile.remove")}
                    loading={vpnOperation?.kind === "remove"}
                    onClick={() => {
                      void removeProfile();
                    }}
                    size="lg"
                    tone="danger"
                  >
                    <TrashIcon />
                  </IconButton>
                ) : null}
              </div>
            </SettingsInlineControls>
          </SettingsFieldRow>
          {status?.profile && !status.profile.isVpnGateFinder ? (
            <SettingsAdvancedGroup
              forceOpen={status.profile.requiresUsernamePassword}
              label={t("settings.data.pluginVpn.credentials.label")}
            >
              <SettingsFieldRow
                description={t("settings.data.pluginVpn.credentials.description")}
                layout="stacked"
              >
                <SettingsWideField>
                  <div className="norea-settings-credentials">
                    <TextInput
                      autoComplete="off"
                      label={t("settings.data.pluginVpn.credentials.username")}
                      value={credentials.username}
                      disabled={profileControlsDisabled}
                      required={status.profile.requiresUsernamePassword}
                      onChange={(event) => {
                        const username = event.currentTarget.value;
                        setCredentials((current) => ({
                          ...current,
                          username,
                        }));
                      }}
                    />
                    <PasswordInput
                      autoComplete="new-password"
                      label={t("settings.data.pluginVpn.credentials.password")}
                      value={credentials.password}
                      disabled={profileControlsDisabled}
                      required={status.profile.requiresUsernamePassword}
                      onChange={(event) => {
                        const password = event.currentTarget.value;
                        setCredentials((current) => ({
                          ...current,
                          password,
                        }));
                      }}
                    />
                    <PasswordInput
                      autoComplete="new-password"
                      label={t("settings.data.pluginVpn.credentials.privateKeyPassword")}
                      value={credentials.privateKeyPassword}
                      disabled={profileControlsDisabled}
                      onChange={(event) => {
                        const privateKeyPassword = event.currentTarget.value;
                        setCredentials((current) => ({
                          ...current,
                          privateKeyPassword,
                        }));
                      }}
                    />
                    <PasswordInput
                      autoComplete="new-password"
                      label={t("settings.data.pluginVpn.credentials.challengeResponse")}
                      value={credentials.challengeResponse}
                      disabled={profileControlsDisabled}
                      onChange={(event) => {
                        const challengeResponse = event.currentTarget.value;
                        setCredentials((current) => ({
                          ...current,
                          challengeResponse,
                        }));
                      }}
                    />
                  </div>
                </SettingsWideField>
              </SettingsFieldRow>
            </SettingsAdvancedGroup>
          ) : null}
          <SettingsAdvancedGroup forceOpen={verdictQuery.isError}>
            <SavedVpnProfilesSettings
              connectingProfileId={vpnOperation?.kind === "saved" ? vpnOperation.candidateId : null}
              disabled={isBusy || vpnOperation !== null}
              onConnect={(profile) => { void connectSavedProfile(profile); }}
            />
            <SettingsFieldRow
              description={t("settings.data.pluginVpn.tested.description")}
              label={t("settings.data.pluginVpn.tested.label")}
              layout="stacked"
            >
              <SettingsWideField>
                <TestedVpnServers disabled={isBusy || vpnOperation !== null} />
              </SettingsWideField>
            </SettingsFieldRow>
          </SettingsAdvancedGroup>
          <PluginVpnFinder
            connectionError={visibleStatusError}
            connectionPhase={displayPhase}
            connectionTarget={status?.profile?.remoteHost ?? null}
            disabled={finderDisabled}
            disabledReason={finderDisabledReason}
            onAddToPreferred={addFinderServersToPreferred}
            onApplyAndConnect={applyAndConnectFinderServer}
            onCancelConnection={disconnect}
            onClose={() => setFinderOpen(false)}
            onVerdictChange={updateServerVerdict}
            opened={finderOpen}
            pendingCandidateId={
              vpnOperation?.kind === "finder"
                ? vpnOperation.candidateId
                : null
            }
            verdictControlsDisabled={verdictControlsDisabled}
            verdictDisabledReason={verdictDisabledReason}
            verdictSavingIps={verdictSavingIps}
            verdicts={verdicts}
          />
        </>
      )}
    </SettingsSection>
  );
}
