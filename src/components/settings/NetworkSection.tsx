import { useRef, useState } from "react";
import { PasswordInput, Text, TextInput } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConsoleChip } from "../ConsolePrimitives";
import { PluginVpnFinder } from "../PluginVpnFinder";
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
  CloseIcon,
  ConnectIcon,
  DisconnectIcon,
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
  pluginVpnFinderProfileIp,
  removePluginVpnProfile,
  switchPluginVpnFinderServer,
  PluginVpnConnectionNotEstablishedError,
  type PluginVpnCredentials,
  type PluginVpnPhase,
  type PluginVpnStatus,
} from "../../lib/plugin-vpn";
import {
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
      kind: "finder";
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
        vpnOperation?.kind === "finder";
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
  const currentFinderIp = pluginVpnFinderProfileIp(status?.profile);
  const verdicts = new Map(
    (verdictQuery.data ?? []).map((row) => [row.ip, row.verdict]),
  );
  const localPhase: PluginVpnPhase | undefined =
    vpnOperation?.kind === "connect"
      ? "connecting"
      : vpnOperation?.kind === "disconnect"
        ? "disconnecting"
        : vpnOperation?.kind === "finder"
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
    vpnOperation?.kind === "connect" || vpnOperation?.kind === "finder";
  const showConnectionStop =
    vpnEnabled ||
    connectionRequestActive ||
    vpnOperation?.kind === "disconnect" ||
    (status !== undefined && status.phase !== "disabled");
  const cancelConnection =
    connectionRequestActive ||
    status?.phase === "connecting" ||
    status?.phase === "reconnecting";
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
    if (
      verdictControlsDisabled ||
      verdictSavingIpsRef.current.has(ip)
    ) {
      return;
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
      if (result.cleanupError) throw new Error(result.cleanupError);
    } catch (error) {
      showSettingsToast(
        "danger",
        t("settings.data.pluginVpn.title"),
        t("settings.data.pluginVpn.finder.verdict.saveFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      void queryClient.invalidateQueries({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: VPN_GATE_SERVER_VERDICTS_QUERY_KEY });
      updateVerdictSavingState(ip, false);
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

  async function applyAndConnectFinderServer(
    candidateId: string,
  ): Promise<void> {
    if (finderDisabled) return;
    const request = ++connectionRequest.current;
    setCredentials(emptyPluginVpnCredentials());
    setVpnOperation({ candidateId, kind: "finder", phase: "disconnecting" });
    try {
      const nextStatus = await switchPluginVpnFinderServer(candidateId, {
        isCurrent: () => isCurrentConnectionRequest(request),
        onConnecting: () => {
          if (isCurrentConnectionRequest(request)) {
            setVpnOperation({ candidateId, kind: "finder", phase: "connecting" });
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
            label={t("settings.data.pluginVpn.status.label")}
            description={t("settings.data.pluginVpn.status.description")}
            error={vpnQuery.isError ? t("common.loadFailed") : visibleStatusError}
          >
            <SettingsInlineControls>
              <ConsoleChip tone={displayPhase === "connected" ? "accent" : undefined}>
                {vpnQuery.isError
                  ? t("common.loadFailed")
                  : displayPhase
                    ? t(PLUGIN_VPN_PHASE_KEYS[displayPhase])
                    : t("settings.data.pluginVpn.status.loading")}
              </ConsoleChip>
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
              ) : null}
            </SettingsInlineControls>
          </SettingsFieldRow>
          <SettingsFieldRow
            label={t("settings.data.pluginVpn.connection.label")}
            description={t("settings.data.pluginVpn.connection.description")}
          >
            <SettingsInlineControls>
              {!stopAction ? (
                <IconButton
                  label={t("settings.data.pluginVpn.connection.connect")}
                  size="lg"
                  disabled={!canConnect}
                  onClick={() => {
                    void connect();
                  }}
                >
                  <ConnectIcon />
                </IconButton>
              ) : cancelConnection ? (
                <IconButton
                  label={t("settings.data.pluginVpn.connection.cancel")}
                  size="lg"
                  disabled={stopDisabled}
                  loading={vpnOperation?.kind === "disconnect"}
                  onClick={() => {
                    void disconnect();
                  }}
                >
                  <CloseIcon />
                </IconButton>
              ) : (
                <IconButton
                  label={t("settings.data.pluginVpn.connection.disconnect")}
                  size="lg"
                  disabled={stopDisabled}
                  loading={vpnOperation?.kind === "disconnect"}
                  onClick={() => {
                    void disconnect();
                  }}
                >
                  <DisconnectIcon />
                </IconButton>
              )}
            </SettingsInlineControls>
          </SettingsFieldRow>
          <SettingsFieldRow
            label={t("settings.data.pluginVpn.profile.label")}
            description={t("settings.data.pluginVpn.profile.description")}
          >
            <SettingsInlineControls>
              <Text className="norea-settings-path-value norea-settings-profile-host">
                {status?.profile?.remoteHost ??
                  t("settings.data.pluginVpn.profile.empty")}
              </Text>
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
            </SettingsInlineControls>
          </SettingsFieldRow>
          {currentFinderIp ? (
            <SettingsFieldRow
              label={t("settings.data.pluginVpn.finder.verdict.label")}
              description={t(
                "settings.data.pluginVpn.finder.verdict.description",
              )}
            >
              <SettingsInlineControls compact>
                <Text className="norea-settings-inline-value" size="sm">
                  {currentFinderIp}
                </Text>
                <VpnGateServerVerdictControl
                  disabled={
                    verdictControlsDisabled ||
                    verdictSavingIps.has(currentFinderIp)
                  }
                  disabledReason={
                    verdictSavingIps.has(currentFinderIp)
                      ? t("settings.data.pluginVpn.finder.verdict.saving")
                      : verdictDisabledReason
                  }
                  ip={currentFinderIp}
                  onChange={(verdict) =>
                    updateServerVerdict(
                      currentFinderIp,
                      verdict,
                      status?.profile
                        ? { kind: "active", expectedHash: status.profile.hash }
                        : undefined,
                    )
                  }
                  verdict={verdicts.get(currentFinderIp) ?? null}
                />
              </SettingsInlineControls>
            </SettingsFieldRow>
          ) : null}
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
            <SavedVpnProfilesSettings disabled={isBusy || vpnOperation !== null} />
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
