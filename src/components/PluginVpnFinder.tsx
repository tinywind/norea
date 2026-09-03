import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { VpnGateServerVerdictValue } from "../db/queries/vpn-gate-server-verdict";
import { useTranslation } from "../i18n";
import {
  loadPluginVpnFinderServers,
  type PluginVpnFinderServer,
  type PluginVpnPhase,
  type PluginVpnServerProtocol,
} from "../lib/plugin-vpn";
import { TextButton } from "./TextButton";
import { VpnGateServerVerdictControl } from "./VpnGateServerVerdictControl";
import "../styles/plugin-vpn-finder.css";

const PLUGIN_VPN_FINDER_QUERY_KEY = ["plugin-vpn", "finder"] as const;
const PLUGIN_VPN_FINDER_REFRESH_INTERVAL_MS = 4 * 60 * 1000;

type PluginVpnFinderSort = "ping" | "score" | "speed";

interface PluginVpnFinderFilters {
  countryCode: string;
  protocol: "" | PluginVpnServerProtocol;
  search: string;
  sort: PluginVpnFinderSort;
}

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
  ) => Promise<void>;
  opened: boolean;
  pendingCandidateId: string | null;
  verdictControlsDisabled: boolean;
  verdictDisabledReason: string | null;
  verdictSavingIps: ReadonlySet<string>;
  verdicts: ReadonlyMap<string, VpnGateServerVerdictValue>;
}

export type PluginVpnFinderServerAction = "cancel" | "connect" | "switch";

export function pluginVpnFinderServerAction(
  candidateId: string,
  pendingCandidateId: string | null,
  phase: PluginVpnPhase | undefined,
): PluginVpnFinderServerAction {
  if (pendingCandidateId === candidateId) return "cancel";
  return pendingCandidateId !== null ||
    phase === "connecting" ||
    phase === "connected" ||
    phase === "reconnecting" ||
    phase === "disconnecting" ||
    phase === "error"
    ? "switch"
    : "connect";
}

export function pluginVpnFinderServersForDisplay(
  servers: PluginVpnFinderServer[],
  queryActive: boolean,
): PluginVpnFinderServer[] {
  return queryActive ? [] : servers;
}

export function pluginVpnFinderServerVerdict(
  server: Pick<PluginVpnFinderServer, "ip">,
  verdicts: ReadonlyMap<string, VpnGateServerVerdictValue>,
): VpnGateServerVerdictValue | null {
  return verdicts.get(server.ip) ?? null;
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
  filters: PluginVpnFinderFilters,
): PluginVpnFinderServer[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return servers
    .filter((server) => {
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
  const queryClient = useQueryClient();
  const [countryCode, setCountryCode] = useState("");
  const [catalogStopped, setCatalogStopped] = useState(false);
  const [selectedConnectionTarget, setSelectedConnectionTarget] = useState<
    string | null
  >(null);
  const [protocol, setProtocol] = useState<"" | PluginVpnServerProtocol>("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PluginVpnFinderSort>("score");
  const serversQuery = useQuery({
    enabled: opened && !catalogStopped,
    queryFn: ({ signal }) => loadPluginVpnFinderServers(true, signal),
    queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
    refetchInterval:
      opened && !catalogStopped
        ? PLUGIN_VPN_FINDER_REFRESH_INTERVAL_MS
        : false,
    retry: false,
    staleTime: PLUGIN_VPN_FINDER_REFRESH_INTERVAL_MS,
  });
  const catalogRefreshing = serversQuery.isFetching && !catalogStopped;
  const servers = pluginVpnFinderServersForDisplay(
    serversQuery.data ?? [],
    catalogRefreshing || catalogStopped,
  );
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
  const visibleServers = useMemo(
    () =>
      filterAndSortPluginVpnServers(servers, {
        countryCode,
        protocol,
        search,
        sort,
      }),
    [countryCode, protocol, search, servers, sort],
  );
  const connectionServer =
    (pendingCandidateId === null ? connectionTarget : selectedConnectionTarget) ??
    t("settings.data.pluginVpn.finder.status.selectedServer");

  useEffect(() => {
    if (!opened) return;
    setCatalogStopped(false);
    queryClient.setQueryData<PluginVpnFinderServer[]>(
      PLUGIN_VPN_FINDER_QUERY_KEY,
      [],
    );
    if (
      queryClient.isFetching({
        exact: true,
        queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
      }) === 0
    ) {
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
        refetchType: "active",
      });
    }
  }, [opened, queryClient]);

  async function applyAndConnect(
    candidateId: string,
    target: string,
  ): Promise<void> {
    const action = pluginVpnFinderServerAction(
      candidateId,
      pendingCandidateId,
      connectionPhase,
    );
    if (action === "cancel") {
      await onCancelConnection();
      return;
    }
    if (!disabled) {
      setSelectedConnectionTarget(target);
      await onApplyAndConnect(candidateId);
    }
  }

  function cancelCatalogQuery(): void {
    setCatalogStopped(true);
    queryClient.setQueryData<PluginVpnFinderServer[]>(
      PLUGIN_VPN_FINDER_QUERY_KEY,
      [],
    );
    void queryClient.cancelQueries({
      exact: true,
      queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
    });
  }

  function refreshCatalog(): void {
    queryClient.setQueryData<PluginVpnFinderServer[]>(
      PLUGIN_VPN_FINDER_QUERY_KEY,
      [],
    );
    setCatalogStopped(false);
    void serversQuery.refetch({ cancelRefetch: true });
  }

  function closeFinder(): void {
    queryClient.setQueryData<PluginVpnFinderServer[]>(
      PLUGIN_VPN_FINDER_QUERY_KEY,
      [],
    );
    void queryClient
      .cancelQueries({
        exact: true,
        queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
      })
      .then(() =>
        queryClient.invalidateQueries({
          exact: true,
          queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
          refetchType: "none",
        }),
      );
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

  function actionText(action: PluginVpnFinderServerAction): string {
    if (action === "cancel") {
      return t("settings.data.pluginVpn.connection.cancel");
    }
    return action === "switch"
      ? t("settings.data.pluginVpn.finder.switchAndConnect")
      : t("settings.data.pluginVpn.finder.applyAndConnect");
  }

  function serverAction(candidateId: string): PluginVpnFinderServerAction {
    return pluginVpnFinderServerAction(
      candidateId,
      pendingCandidateId,
      connectionPhase,
    );
  }

  return (
    <Modal
      centered
      closeButtonProps={{
        "aria-label": t("settings.data.pluginVpn.finder.close"),
      }}
      onClose={closeFinder}
      opened={opened}
      size="68rem"
      title={t("settings.data.pluginVpn.finder.title")}
    >
      <Stack gap="sm">
        <Text size="sm">
          {t("settings.data.pluginVpn.finder.description")}
        </Text>
        {pendingCandidateId !== null ||
        connectionPhase === "connecting" ||
        connectionPhase === "reconnecting" ? (
          <Stack className="lnr-plugin-vpn-finder-state" gap="xs">
            <Group aria-live="polite" gap="xs" role="status">
              <Loader size="sm" />
              <Text size="sm">
                {connectionPhase === "disconnecting"
                  ? t("settings.data.pluginVpn.finder.status.switching", {
                      server: connectionServer,
                    })
                  : connectionPhase === "reconnecting"
                    ? t("settings.data.pluginVpn.status.reconnecting")
                    : t("settings.data.pluginVpn.finder.status.connecting", {
                        server: connectionServer,
                      })}
              </Text>
            </Group>
            <TextButton
              onClick={() => void onCancelConnection()}
              size="sm"
              variant="default"
            >
              {t("settings.data.pluginVpn.connection.cancel")}
            </TextButton>
          </Stack>
        ) : connectionPhase === "connected" ? (
          <Text
            aria-live="polite"
            className="lnr-plugin-vpn-finder-state"
            role="status"
            size="sm"
          >
            {t("settings.data.pluginVpn.finder.status.connected")}
          </Text>
        ) : connectionPhase === "disconnecting" ? (
          <Group
            aria-live="polite"
            className="lnr-plugin-vpn-finder-state"
            role="status"
          >
            <Loader size="sm" />
            <Text size="sm">
              {t("settings.data.pluginVpn.status.disconnecting")}
            </Text>
          </Group>
        ) : connectionPhase === "error" ? (
          <Text className="lnr-plugin-vpn-finder-state" role="alert" size="sm">
            {connectionError ?? t("settings.data.pluginVpn.status.error")}
          </Text>
        ) : connectionError ? (
          <Text className="lnr-plugin-vpn-finder-state" role="alert" size="sm">
            {connectionError}
          </Text>
        ) : null}
        {disabled && disabledReason ? (
          <Text className="lnr-plugin-vpn-finder-state" role="status" size="sm">
            {disabledReason}
          </Text>
        ) : null}
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="xs">
          <TextInput
            label={t("settings.data.pluginVpn.finder.search.label")}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={t("settings.data.pluginVpn.finder.search.placeholder")}
            value={search}
          />
          <Select
            clearable
            data={countries}
            label={t("settings.data.pluginVpn.finder.country.label")}
            onChange={(value) => setCountryCode(value ?? "")}
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
              setProtocol((value ?? "") as "" | PluginVpnServerProtocol)
            }
            value={protocol}
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
              setSort((value ?? "score") as PluginVpnFinderSort)
            }
            value={sort}
          />
        </SimpleGrid>
        <Group justify="space-between">
          <Text c="dimmed" size="xs">
            {t("settings.data.pluginVpn.finder.sourceAttribution")}
          </Text>
          <TextButton
            active={catalogRefreshing}
            onClick={catalogRefreshing ? cancelCatalogQuery : refreshCatalog}
            size="sm"
            variant="default"
          >
            {catalogRefreshing
              ? t("settings.data.pluginVpn.finder.cancelSearch")
              : t("settings.data.pluginVpn.finder.refresh")}
          </TextButton>
        </Group>

        {catalogStopped ? (
          <Stack className="lnr-plugin-vpn-finder-state" gap="xs">
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
        ) : catalogRefreshing || serversQuery.isPending ? (
          <Group className="lnr-plugin-vpn-finder-state" justify="center">
            <Loader size="sm" />
            <Text size="sm">
              {t("settings.data.pluginVpn.finder.loading")}
            </Text>
          </Group>
        ) : serversQuery.isError ? (
          <Stack className="lnr-plugin-vpn-finder-state" gap="xs">
            <Text role="alert" size="sm">
              {t("settings.data.pluginVpn.finder.loadFailed")}
            </Text>
            {loadErrorMessage ? (
              <Text c="dimmed" size="xs">
                {loadErrorMessage}
              </Text>
            ) : null}
            <TextButton
              onClick={refreshCatalog}
              size="sm"
              variant="default"
            >
              {t("settings.data.pluginVpn.finder.retry")}
            </TextButton>
          </Stack>
        ) : visibleServers.length === 0 ? (
          <Text className="lnr-plugin-vpn-finder-state" size="sm">
            {t("settings.data.pluginVpn.finder.empty")}
          </Text>
        ) : (
          <ScrollArea.Autosize mah="min(36rem, 60vh)" offsetScrollbars>
            <div className="lnr-plugin-vpn-finder-table">
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
                            onVerdictChange(server.ip, verdict)
                          }
                          verdict={pluginVpnFinderServerVerdict(server, verdicts)}
                        />
                      </Table.Td>
                      <Table.Td>
                        <TextButton
                          active={serverAction(server.candidateId) === "cancel"}
                          disabled={
                            serverAction(server.candidateId) !== "cancel" &&
                            disabled
                          }
                          onClick={() =>
                            void applyAndConnect(server.candidateId, server.ip)
                          }
                          size="sm"
                          variant={
                            serverAction(server.candidateId) === "cancel"
                              ? "default"
                              : "filled"
                          }
                        >
                          {actionText(serverAction(server.candidateId))}
                        </TextButton>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            <div className="lnr-plugin-vpn-finder-cards">
              {visibleServers.map((server) => (
                <section
                  className="lnr-plugin-vpn-finder-card"
                  key={server.candidateId}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text fw={700} size="sm">
                      {countryFlag(server.countryCode)} {server.countryName}
                    </Text>
                    <Badge variant="light">
                      {server.protocol === "tcp"
                        ? t("settings.data.pluginVpn.finder.protocol.tcp")
                        : t("settings.data.pluginVpn.finder.protocol.udp")}
                    </Badge>
                  </Group>
                  <dl className="lnr-plugin-vpn-finder-metadata">
                    <div>
                      <dt>{t("settings.data.pluginVpn.finder.metadata.ip")}</dt>
                      <dd>{server.ip}</dd>
                    </div>
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
                    <div>
                      <dt>{t("settings.data.pluginVpn.finder.verdict.label")}</dt>
                      <dd>
                        <VpnGateServerVerdictControl
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
                            onVerdictChange(server.ip, verdict)
                          }
                          verdict={pluginVpnFinderServerVerdict(server, verdicts)}
                        />
                      </dd>
                    </div>
                  </dl>
                  <TextButton
                    active={serverAction(server.candidateId) === "cancel"}
                    disabled={
                      serverAction(server.candidateId) !== "cancel" && disabled
                    }
                    fullWidth
                    onClick={() =>
                      void applyAndConnect(server.candidateId, server.ip)
                    }
                    variant={
                      serverAction(server.candidateId) === "cancel"
                        ? "default"
                        : "filled"
                    }
                  >
                    {actionText(serverAction(server.candidateId))}
                  </TextButton>
                </section>
              ))}
            </div>
          </ScrollArea.Autosize>
        )}
      </Stack>
    </Modal>
  );
}
