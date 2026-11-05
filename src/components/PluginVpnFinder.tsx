import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Group,
  Loader,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { VpnGateServerVerdictValue } from "../db/queries/vpn-gate-server-verdict";
import type { SavedVpnProfileCaptureSource } from "../lib/plugin-vpn-profiles";
import { useTranslation } from "../i18n";
import { useNetworkStore } from "../lib/network";
import {
  usePluginVpnFinderStore,
  type PluginVpnFinderFilters,
  type PluginVpnFinderSort,
} from "../store/plugin-vpn-finder";
import {
  loadPluginVpnFinderServers,
  pluginVpnFinderLoadFailure,
  type PluginVpnFinderServer,
  type PluginVpnPhase,
  type PluginVpnServerProtocol,
} from "../lib/plugin-vpn";
import { IconButton } from "./IconButton";
import { TextButton } from "./TextButton";
import { CloseIcon, ConnectIcon, RefreshIcon } from "./ui/icons";
import { ResponsiveSheet } from "./ui/ResponsiveSheet";
import { VpnGateServerVerdictControl } from "./VpnGateServerVerdictControl";
import "../styles/plugin-vpn-finder.css";

const PLUGIN_VPN_FINDER_QUERY_KEY = ["plugin-vpn", "finder"] as const;

interface PluginVpnFinderProps {
  connectionError: string | null;
  connectionPhase: PluginVpnPhase | undefined;
  connectionTarget: string | null;
  disabled: boolean;
  disabledReason: string | null;
  onApplyAndConnect: (candidateId: string) => Promise<void>;
  onCancelConnection: () => Promise<void>;
  onClose: () => void;
  onVerdictChange: (
    ip: string,
    verdict: VpnGateServerVerdictValue | null,
    source: SavedVpnProfileCaptureSource,
  ) => Promise<void>;
  opened: boolean;
  pendingCandidateId: string | null;
  verdictControlsDisabled: boolean;
  verdictDisabledReason: string | null;
  verdictSavingIps: ReadonlySet<string>;
  verdicts: ReadonlyMap<string, VpnGateServerVerdictValue>;
}

export type PluginVpnFinderServerAction = "cancel" | "connect";

export function pluginVpnFinderServerAction(
  candidateId: string,
  pendingCandidateId: string | null,
): PluginVpnFinderServerAction {
  return pendingCandidateId === candidateId ? "cancel" : "connect";
}

export function pluginVpnFinderServerVerdict(
  server: Pick<PluginVpnFinderServer, "ip">,
  verdicts: ReadonlyMap<string, VpnGateServerVerdictValue>,
): VpnGateServerVerdictValue | null {
  return verdicts.get(server.ip) ?? null;
}

export function pluginVpnFinderVerdictCaptureSource(
  server: Pick<PluginVpnFinderServer, "candidateId">,
): SavedVpnProfileCaptureSource {
  return { kind: "finder", candidateId: server.candidateId };
}

function comparePing(
  left: PluginVpnFinderServer,
  right: PluginVpnFinderServer,
): number {
  if (left.pingMs === null) return right.pingMs === null ? 0 : 1;
  if (right.pingMs === null) return -1;
  return left.pingMs - right.pingMs;
}

export function filterAndSortPluginVpnServers(
  servers: PluginVpnFinderServer[],
  filters: Omit<PluginVpnFinderFilters, "hideFailed"> & { hideFailed?: boolean },
  verdicts: ReadonlyMap<string, VpnGateServerVerdictValue> = new Map(),
): PluginVpnFinderServer[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return servers
    .filter((server) => {
      if (filters.hideFailed !== false && verdicts.get(server.ip) === "fails") {
        return false;
      }
      if (filters.countryCode && server.countryCode !== filters.countryCode) {
        return false;
      }
      if (filters.protocol && server.protocol !== filters.protocol) {
        return false;
      }
      if (!search) return true;
      return [
        server.countryCode,
        server.countryName,
        server.hostName,
        server.ip,
      ].some((value) => value.toLocaleLowerCase().includes(search));
    })
    .sort((left, right) => {
      let order: number;
      switch (filters.sort) {
        case "ping":
          order = comparePing(left, right);
          break;
        case "speed":
          order = right.speedBps - left.speedBps;
          break;
        default:
          order = right.score - left.score;
      }
      return order || left.candidateId.localeCompare(right.candidateId);
    });
}

/** A remembered country that the current server list no longer offers falls back to every country. */
export function pluginVpnFinderAvailableCountry(
  countryCode: string,
  countries: readonly { value: string }[],
): string {
  return countries.some((country) => country.value === countryCode)
    ? countryCode
    : "";
}

function countryFlag(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode)) return "";
  return String.fromCodePoint(
    ...[...countryCode].map((character) => character.charCodeAt(0) + 127_397),
  );
}

function formatPingValue(pingMs: number | null, locale: string): string | null {
  return pingMs === null ? null : pingMs.toLocaleString(locale);
}

function formatSpeedValue(speedBps: number, locale: string): string {
  return (speedBps / 1_000_000).toLocaleString(locale, {
    maximumFractionDigits: 1,
  });
}

export function pluginVpnFinderErrorMessage(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return null;
}

export function PluginVpnFinderLoadFailureNotice({
  detail,
}: {
  detail: string | null;
}) {
  const { t } = useTranslation();
  const advice =
    pluginVpnFinderLoadFailure(detail) === "invalidList"
      ? t("settings.data.pluginVpn.finder.loadFailedInvalidList")
      : t("settings.data.pluginVpn.finder.loadFailedUnreachable");
  return (
    <>
      <Text role="alert" size="sm">
        {t("settings.data.pluginVpn.finder.loadFailed")} {advice}
      </Text>
      {detail ? (
        <details className="norea-state-details">
          <summary>{t("common.details")}</summary>
          <Text c="dimmed" component="div" size="xs">
            {detail}
          </Text>
        </details>
      ) : null}
    </>
  );
}

export function PluginVpnFinder({
  connectionError,
  connectionPhase,
  connectionTarget,
  disabled,
  disabledReason,
  onApplyAndConnect,
  onCancelConnection,
  onClose,
  onVerdictChange,
  opened,
  pendingCandidateId,
  verdictControlsDisabled,
  verdictDisabledReason,
  verdictSavingIps,
  verdicts,
}: PluginVpnFinderProps) {
  const { locale, t } = useTranslation();
  const online = useNetworkStore((state) => state.connectivity === "online");
  const queryClient = useQueryClient();
  const filters = usePluginVpnFinderStore((state) => state.filters);
  const setFilters = usePluginVpnFinderStore((state) => state.setFilters);
  const [catalogStopped, setCatalogStopped] = useState(false);
  const forceRefresh = useRef(false);
  const [selectedConnectionTarget, setSelectedConnectionTarget] = useState<
    string | null
  >(null);
  const serversQuery = useQuery({
    meta: { errorPresentation: "inline" },
    enabled: opened && !catalogStopped && online &&
      queryClient.getQueryData(PLUGIN_VPN_FINDER_QUERY_KEY) === undefined,
    queryFn: ({ signal }) => {
      const refresh = forceRefresh.current;
      forceRefresh.current = false;
      return loadPluginVpnFinderServers(refresh, signal);
    },
    queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  });
  const catalogRefreshing = serversQuery.isFetching && !catalogStopped;
  const servers = serversQuery.data ?? [];
  const countries = useMemo(
    () =>
      [...new Map(servers.map((server) => [server.countryCode, server.countryName]))]
        .sort((left, right) => left[1].localeCompare(right[1]))
        .map(([value, countryName]) => ({
          label: `${countryFlag(value)} ${countryName}`.trim(),
          value,
        })),
    [servers],
  );
  const countryCode = pluginVpnFinderAvailableCountry(filters.countryCode, countries);
  const visibleServers = useMemo(
    () =>
      filterAndSortPluginVpnServers(servers, { ...filters, countryCode }, verdicts),
    [countryCode, filters, servers, verdicts],
  );
  const connectionServer =
    (pendingCandidateId === null ? connectionTarget : selectedConnectionTarget) ??
    t("settings.data.pluginVpn.finder.status.selectedServer");

  const connectionStarting = connectionPhase !== "waitingForNetwork" &&
    (pendingCandidateId !== null ||
      connectionPhase === "connecting" ||
      connectionPhase === "reconnecting");
  const connectionNotice: {
    busy: boolean;
    cancellable: boolean;
    message: string;
  } | null = connectionStarting
    ? {
        busy: true,
        cancellable: true,
        message: connectionPhase === "disconnecting"
          ? t("settings.data.pluginVpn.finder.status.switching", {
              server: connectionServer,
            })
          : connectionPhase === "reconnecting"
            ? t("settings.data.pluginVpn.status.reconnecting")
            : t("settings.data.pluginVpn.finder.status.connecting", {
                server: connectionServer,
              }),
      }
    : connectionPhase === "waitingForNetwork"
      ? {
          busy: false,
          cancellable: true,
          message: t("settings.data.pluginVpn.status.waitingForNetwork"),
        }
      : connectionPhase === "connected"
        ? {
            busy: false,
            cancellable: false,
            message: t("settings.data.pluginVpn.finder.status.connected"),
          }
        : connectionPhase === "disconnecting"
          ? {
              busy: true,
              cancellable: false,
              message: t("settings.data.pluginVpn.status.disconnecting"),
            }
          : null;

  const connectRequest = useRef<"idle" | "requested" | "started">("idle");

  // A connection started here closes the finder once it is up; the settings row shows the result.
  useEffect(() => {
    const starting = pendingCandidateId !== null ||
      connectionPhase === "connecting" || connectionPhase === "reconnecting";
    if (connectRequest.current === "requested" && starting) connectRequest.current = "started";
    if (connectRequest.current !== "started" || starting) return;
    connectRequest.current = "idle";
    if (connectionPhase === "connected") closeFinder();
  });

  async function applyAndConnect(
    candidateId: string,
    target: string,
  ): Promise<void> {
    if (pluginVpnFinderServerAction(candidateId, pendingCandidateId) === "cancel") {
      connectRequest.current = "idle";
      await onCancelConnection();
      return;
    }
    if (!disabled) {
      setSelectedConnectionTarget(target);
      connectRequest.current = "requested";
      await onApplyAndConnect(candidateId);
    }
  }

  function cancelCatalogQuery(): void {
    setCatalogStopped(true);
    void queryClient.cancelQueries({
      exact: true,
      queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
    });
  }

  function refreshCatalog(): void {
    if (!online) return;
    forceRefresh.current = true;
    setCatalogStopped(false);
    void serversQuery.refetch({ cancelRefetch: true });
  }

  function closeFinder(): void {
    void queryClient
      .cancelQueries({
        exact: true,
        queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
      });
    onClose();
  }

  const loadErrorMessage = pluginVpnFinderErrorMessage(serversQuery.error);

  function pingText(pingMs: number | null): string {
    const value = formatPingValue(pingMs, locale);
    return value === null
      ? t("settings.data.pluginVpn.finder.value.unavailable")
      : t("settings.data.pluginVpn.finder.value.ping", { value });
  }

  function speedText(speedBps: number): string {
    return t("settings.data.pluginVpn.finder.value.speed", {
      value: formatSpeedValue(speedBps, locale),
    });
  }

  function connectButton(server: PluginVpnFinderServer) {
    const connecting =
      pluginVpnFinderServerAction(server.candidateId, pendingCandidateId) === "cancel";
    return (
      <IconButton
        active={connecting}
        disabled={!connecting && disabled}
        label={connecting
          ? t("settings.data.pluginVpn.connection.cancel")
          : t("settings.data.pluginVpn.connection.connect")}
        onClick={() => void applyAndConnect(server.candidateId, server.ip)}
      >
        {connecting ? <Loader size={14} /> : <ConnectIcon />}
      </IconButton>
    );
  }

  return (
    <ResponsiveSheet
      closeLabel={t("settings.data.pluginVpn.finder.close")}
      fullScreenOnPhone
      onClose={closeFinder}
      opened={opened}
      size="xl"
      title={t("settings.data.pluginVpn.finder.title")}
    >
      <Stack className="norea-plugin-vpn-finder-content" gap="sm">
        <Text size="sm">
          {t("settings.data.pluginVpn.finder.description")}
        </Text>
        {connectionNotice ? (
          <div
            className="norea-plugin-vpn-finder-connection"
            data-phase={connectionPhase}
          >
            {connectionNotice.busy ? <Loader size="xs" /> : null}
            <Text
              aria-live="polite"
              className="norea-plugin-vpn-finder-connection-text"
              role="status"
              size="sm"
            >
              {connectionNotice.message}
            </Text>
            {connectionNotice.cancellable ? (
              <IconButton
                label={t("settings.data.pluginVpn.connection.cancel")}
                onClick={() => void onCancelConnection()}
              >
                <CloseIcon />
              </IconButton>
            ) : null}
          </div>
        ) : connectionPhase === "error" ? (
          <Text className="norea-plugin-vpn-finder-state" role="alert" size="sm">
            {connectionError ?? t("settings.data.pluginVpn.status.error")}
          </Text>
        ) : connectionPhase !== "disabled" && connectionError ? (
          <Text className="norea-plugin-vpn-finder-state" role="alert" size="sm">
            {connectionError}
          </Text>
        ) : null}
        {disabled && disabledReason ? (
          <Text className="norea-plugin-vpn-finder-state" role="status" size="sm">
            {disabledReason}
          </Text>
        ) : null}
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
          <TextInput
            label={t("settings.data.pluginVpn.finder.search.label")}
            onChange={(event) => setFilters({ search: event.currentTarget.value })}
            placeholder={t("settings.data.pluginVpn.finder.search.placeholder")}
            value={filters.search}
          />
          <Select
            clearable
            data={countries}
            label={t("settings.data.pluginVpn.finder.country.label")}
            onChange={(value) => setFilters({ countryCode: value ?? "" })}
            placeholder={t("settings.data.pluginVpn.finder.country.all")}
            searchable
            value={countryCode || null}
          />
          <Select
            data={[
              {
                label: t("settings.data.pluginVpn.finder.protocol.all"),
                value: "",
              },
              {
                label: t("settings.data.pluginVpn.finder.protocol.tcp"),
                value: "tcp",
              },
              {
                label: t("settings.data.pluginVpn.finder.protocol.udp"),
                value: "udp",
              },
            ]}
            label={t("settings.data.pluginVpn.finder.protocol.label")}
            onChange={(value) =>
              setFilters({ protocol: (value ?? "") as "" | PluginVpnServerProtocol })
            }
            value={filters.protocol}
          />
          <Select
            data={[
              {
                label: t("settings.data.pluginVpn.finder.sort.score"),
                value: "score",
              },
              {
                label: t("settings.data.pluginVpn.finder.sort.speed"),
                value: "speed",
              },
              {
                label: t("settings.data.pluginVpn.finder.sort.ping"),
                value: "ping",
              },
            ]}
            label={t("settings.data.pluginVpn.finder.sort.label")}
            onChange={(value) =>
              setFilters({ sort: (value ?? "score") as PluginVpnFinderSort })
            }
            value={filters.sort}
          />
        </SimpleGrid>
        <Switch
          checked={filters.hideFailed}
          label={t("settings.data.pluginVpn.finder.verdict.hideFailed")}
          onChange={(event) => setFilters({ hideFailed: event.currentTarget.checked })}
        />
        <Group justify="space-between">
          <Text c="dimmed" size="xs">
            {t("settings.data.pluginVpn.finder.sourceAttribution")}
          </Text>
          <IconButton
            active={catalogRefreshing}
            disabled={!online}
            label={catalogRefreshing
              ? t("settings.data.pluginVpn.finder.cancelSearch")
              : t("settings.data.pluginVpn.finder.refresh")}
            onClick={catalogRefreshing ? cancelCatalogQuery : refreshCatalog}
            size="lg"
          >
            {catalogRefreshing ? <CloseIcon /> : <RefreshIcon />}
          </IconButton>
        </Group>

        {serversQuery.isError && serversQuery.data !== undefined ? (
          <Stack className="norea-plugin-vpn-finder-state" gap="xs">
            <PluginVpnFinderLoadFailureNotice detail={loadErrorMessage} />
          </Stack>
        ) : null}
        {!online && servers.length === 0 ? (
          <Text className="norea-plugin-vpn-finder-state" role="status" size="sm">
            {t("network.waiting")}
          </Text>
        ) : catalogStopped && servers.length === 0 ? (
          <Stack className="norea-plugin-vpn-finder-state" gap="xs">
            <Text role="status" size="sm">
              {t("settings.data.pluginVpn.finder.stopped")}
            </Text>
            <TextButton
              onClick={refreshCatalog}
              size="sm"
              variant="default"
            >
              {t("settings.data.pluginVpn.finder.retry")}
            </TextButton>
          </Stack>
        ) : (catalogRefreshing || serversQuery.isPending) && serversQuery.data === undefined ? (
          <Group className="norea-plugin-vpn-finder-state" justify="center">
            <Loader size="sm" />
            <Text size="sm">
              {t("settings.data.pluginVpn.finder.loading")}
            </Text>
          </Group>
        ) : serversQuery.isError && serversQuery.data === undefined ? (
          <Stack className="norea-plugin-vpn-finder-state" gap="xs">
            <PluginVpnFinderLoadFailureNotice detail={loadErrorMessage} />
            <TextButton
              onClick={refreshCatalog}
              size="sm"
              variant="default"
            >
              {t("settings.data.pluginVpn.finder.retry")}
            </TextButton>
          </Stack>
        ) : visibleServers.length === 0 ? (
          <Text className="norea-plugin-vpn-finder-state" size="sm">
            {t("settings.data.pluginVpn.finder.empty")}
          </Text>
        ) : (
          <ScrollArea.Autosize mah="min(36rem, 60vh)" offsetScrollbars>
            <div className="norea-plugin-vpn-finder-table">
              <Table highlightOnHover stickyHeader verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("settings.data.pluginVpn.finder.metadata.country")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.metadata.ip")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.metadata.score")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.metadata.ping")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.metadata.speed")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.metadata.sessions")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.metadata.logPolicy")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.protocol.label")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.verdict.label")}</Table.Th>
                    <Table.Th>{t("settings.data.pluginVpn.finder.metadata.action")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {visibleServers.map((server) => (
                    <Table.Tr key={server.candidateId}>
                      <Table.Td>
                        {countryFlag(server.countryCode)} {server.countryName}
                      </Table.Td>
                      <Table.Td>{server.ip}</Table.Td>
                      <Table.Td>{server.score.toLocaleString(locale)}</Table.Td>
                      <Table.Td>{pingText(server.pingMs)}</Table.Td>
                      <Table.Td>{speedText(server.speedBps)}</Table.Td>
                      <Table.Td>
                        {server.activeSessions.toLocaleString(locale)}
                      </Table.Td>
                      <Table.Td>{server.logType}</Table.Td>
                      <Table.Td>
                        {server.protocol === "tcp"
                          ? t("settings.data.pluginVpn.finder.protocol.tcp")
                          : t("settings.data.pluginVpn.finder.protocol.udp")}
                      </Table.Td>
                      <Table.Td>
                        <VpnGateServerVerdictControl
                          size="sm"
                          disabled={
                            verdictControlsDisabled ||
                            verdictSavingIps.has(server.ip)
                          }
                          disabledReason={
                            verdictSavingIps.has(server.ip)
                              ? t("settings.data.pluginVpn.finder.verdict.saving")
                              : verdictDisabledReason
                          }
                          ip={server.ip}
                          onChange={(verdict) =>
                            onVerdictChange(
                              server.ip,
                              verdict,
                              pluginVpnFinderVerdictCaptureSource(server),
                            )
                          }
                          verdict={pluginVpnFinderServerVerdict(server, verdicts)}
                        />
                      </Table.Td>
                      <Table.Td>{connectButton(server)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            <div className="norea-plugin-vpn-finder-cards">
              {visibleServers.map((server) => (
                <section
                  className="norea-plugin-vpn-finder-card"
                  key={server.candidateId}
                >
                  <div className="norea-plugin-vpn-finder-card-header">
                    <div className="norea-plugin-vpn-finder-card-identity">
                      <Text
                        className="norea-plugin-vpn-finder-card-country"
                        component="span"
                        fw="var(--norea-weight-bold)"
                        size="sm"
                      >
                        {countryFlag(server.countryCode)} {server.countryName}
                      </Text>
                      <Text
                        c="dimmed"
                        className="norea-plugin-vpn-finder-card-ip"
                        component="span"
                        size="xs"
                      >
                        {server.ip}
                      </Text>
                    </div>
                    <Group gap="xs" wrap="nowrap">
                      <Badge size="sm" variant="light">
                        {server.protocol === "tcp"
                          ? t("settings.data.pluginVpn.finder.protocol.tcp")
                          : t("settings.data.pluginVpn.finder.protocol.udp")}
                      </Badge>
                      <VpnGateServerVerdictControl
                        size="sm"
                        disabled={
                          verdictControlsDisabled ||
                          verdictSavingIps.has(server.ip)
                        }
                        disabledReason={
                          verdictSavingIps.has(server.ip)
                            ? t("settings.data.pluginVpn.finder.verdict.saving")
                            : verdictDisabledReason
                        }
                        ip={server.ip}
                        onChange={(verdict) =>
                          onVerdictChange(
                            server.ip,
                            verdict,
                            pluginVpnFinderVerdictCaptureSource(server),
                          )
                        }
                        verdict={pluginVpnFinderServerVerdict(
                          server,
                          verdicts,
                        )}
                      />
                      {connectButton(server)}
                    </Group>
                  </div>
                  <dl className="norea-plugin-vpn-finder-metadata">
                    <div>
                      <dt>{t("settings.data.pluginVpn.finder.metadata.score")}</dt>
                      <dd>{server.score.toLocaleString(locale)}</dd>
                    </div>
                    <div>
                      <dt>{t("settings.data.pluginVpn.finder.metadata.ping")}</dt>
                      <dd>{pingText(server.pingMs)}</dd>
                    </div>
                    <div>
                      <dt>{t("settings.data.pluginVpn.finder.metadata.speed")}</dt>
                      <dd>{speedText(server.speedBps)}</dd>
                    </div>
                    <div>
                      <dt>{t("settings.data.pluginVpn.finder.metadata.sessions")}</dt>
                      <dd>{server.activeSessions.toLocaleString(locale)}</dd>
                    </div>
                    <div>
                      <dt>{t("settings.data.pluginVpn.finder.metadata.logPolicy")}</dt>
                      <dd>{server.logType}</dd>
                    </div>
                  </dl>
                </section>
              ))}
            </div>
          </ScrollArea.Autosize>
        )}
      </Stack>
    </ResponsiveSheet>
  );
}
