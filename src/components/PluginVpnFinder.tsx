import { useMemo, useState } from "react";
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
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import {
  loadPluginVpnFinderServers,
  type PluginVpnFinderServer,
  type PluginVpnServerProtocol,
} from "../lib/plugin-vpn";
import { TextButton } from "./TextButton";
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
  disabled: boolean;
  onApplyAndConnect: (candidateId: string) => Promise<boolean>;
  onClose: () => void;
  opened: boolean;
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

function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message;
  return null;
}

export function PluginVpnFinder({
  disabled,
  onApplyAndConnect,
  onClose,
  opened,
}: PluginVpnFinderProps) {
  const { locale, t } = useTranslation();
  const [applyingCandidateId, setApplyingCandidateId] = useState<string | null>(
    null,
  );
  const [countryCode, setCountryCode] = useState("");
  const [protocol, setProtocol] = useState<"" | PluginVpnServerProtocol>("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PluginVpnFinderSort>("score");
  const serversQuery = useQuery({
    enabled: opened,
    queryFn: () => loadPluginVpnFinderServers(true),
    queryKey: PLUGIN_VPN_FINDER_QUERY_KEY,
    refetchInterval: opened ? PLUGIN_VPN_FINDER_REFRESH_INTERVAL_MS : false,
    staleTime: PLUGIN_VPN_FINDER_REFRESH_INTERVAL_MS,
  });
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
  const applying = applyingCandidateId !== null;
  const catalogRefreshing = serversQuery.isFetching;

  async function applyAndConnect(candidateId: string): Promise<void> {
    if (disabled || applying || catalogRefreshing) return;
    setApplyingCandidateId(candidateId);
    try {
      if (await onApplyAndConnect(candidateId)) onClose();
    } finally {
      setApplyingCandidateId(null);
    }
  }

  function close(): void {
    if (!applying) onClose();
  }

  const loadErrorMessage = errorMessage(serversQuery.error);

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

  return (
    <Modal
      centered
      closeButtonProps={{
        "aria-label": t("settings.data.pluginVpn.finder.close"),
      }}
      closeOnClickOutside={!applying}
      onClose={close}
      opened={opened}
      size="68rem"
      title={t("settings.data.pluginVpn.finder.title")}
      withCloseButton={!applying}
    >
      <Stack gap="sm">
        <Text size="sm">
          {t("settings.data.pluginVpn.finder.description")}
        </Text>
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
            disabled={applying || catalogRefreshing}
            loading={catalogRefreshing}
            onClick={() => void serversQuery.refetch()}
            size="sm"
            variant="default"
          >
            {t("settings.data.pluginVpn.finder.refresh")}
          </TextButton>
        </Group>

        {serversQuery.isPending ? (
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
              disabled={applying || catalogRefreshing}
              loading={catalogRefreshing}
              onClick={() => void serversQuery.refetch()}
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
                        <TextButton
                          disabled={disabled || applying || catalogRefreshing}
                          loading={applyingCandidateId === server.candidateId}
                          onClick={() => void applyAndConnect(server.candidateId)}
                          size="sm"
                        >
                          {t("settings.data.pluginVpn.finder.applyAndConnect")}
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
                  </dl>
                  <TextButton
                    disabled={disabled || applying || catalogRefreshing}
                    fullWidth
                    loading={applyingCandidateId === server.candidateId}
                    onClick={() => void applyAndConnect(server.candidateId)}
                  >
                    {t("settings.data.pluginVpn.finder.applyAndConnect")}
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
