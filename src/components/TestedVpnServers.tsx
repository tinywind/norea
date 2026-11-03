import { useState } from "react";
import { Alert, Group, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDateTimeForLocale, useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import {
  approveWorkingAutomaticPluginVpnProfiles,
  AUTOMATIC_PLUGIN_VPN_PROFILES_QUERY_KEY,
  listAutomaticPluginVpnProfiles,
  type AutomaticVpnProfile,
} from "../lib/plugin-vpn-automatic";
import { SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY } from "../lib/plugin-vpn-profiles";
import { notifyVpnDownloadProfilesChanged } from "../lib/tasks/vpn-download-runtime";
import { showSettingsToast } from "./settings/settings-toast";
import { TextButton } from "./TextButton";

const VPN_GATE_SERVER_VERDICTS_QUERY_KEY = ["vpn-gate-server-verdicts"] as const;

/** A tested server without a recent worker tunnel failure. */
export function isWorkingTestedServer(server: AutomaticVpnProfile): boolean {
  return server.failures === 0;
}

/**
 * The automatic pool of tested VPN Gate servers, for review only. VPN
 * downloads use it by default; these servers carry no O/X verdict, and
 * "Approve all working" is the one action that turns them into O files.
 */
export function TestedVpnServers({ disabled = false }: { disabled?: boolean }) {
  const { locale, t } = useTranslation();
  const client = useQueryClient();
  const [approveError, setApproveError] = useState<string | null>(null);
  const servers = useQuery({
    queryKey: AUTOMATIC_PLUGIN_VPN_PROFILES_QUERY_KEY,
    queryFn: listAutomaticPluginVpnProfiles,
    meta: { errorPresentation: "inline" },
  });
  const working = (servers.data ?? []).filter(isWorkingTestedServer);
  const approve = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async () => {
      const approved = await approveWorkingAutomaticPluginVpnProfiles();
      await notifyVpnDownloadProfilesChanged();
      return approved;
    },
    onMutate: () => setApproveError(null),
    onSuccess: (approved) => {
      showSettingsToast("ok", t("settings.data.pluginVpn.tested.approved", { count: approved.length }));
    },
    onError: (error) => setApproveError(describeError(error)),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: AUTOMATIC_PLUGIN_VPN_PROFILES_QUERY_KEY }),
        client.invalidateQueries({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY }),
        client.invalidateQueries({ queryKey: VPN_GATE_SERVER_VERDICTS_QUERY_KEY }),
      ]),
  });

  if (servers.isPending) {
    return <Text role="status" size="sm">{t("settings.data.pluginVpn.saved.loading")}</Text>;
  }
  if (servers.isError) {
    return (
      <Alert color="danger" role="alert">
        <Text size="sm">{describeError(servers.error)}</Text>
        <TextButton onClick={() => void servers.refetch()}>{t("common.retry")}</TextButton>
      </Alert>
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap">
        <Text role="status" size="sm">
          {t("settings.data.pluginVpn.tested.count", {
            count: servers.data.length,
            working: working.length,
          })}
        </Text>
        <TextButton
          disabled={disabled || working.length === 0}
          loading={approve.isPending}
          onClick={() => approve.mutate()}
        >
          {t("settings.data.pluginVpn.tested.approveAll", { count: working.length })}
        </TextButton>
      </Group>
      {approveError ? <Alert color="danger" role="alert">{approveError}</Alert> : null}
      {servers.data.length === 0 ? (
        <Text c="dimmed" size="sm">{t("settings.data.pluginVpn.tested.empty")}</Text>
      ) : (
        <ul className="norea-tested-vpn-servers">
          {servers.data.map((server) => (
            <li className="norea-tested-vpn-server" key={server.id}>
              <Text fw={600} size="sm">{server.ip}</Text>
              <Text c="dimmed" size="sm">
                {t("settings.data.pluginVpn.tested.details", {
                  date: formatDateTimeForLocale(locale, server.testedAt * 1000),
                  protocol: server.protocol.toUpperCase(),
                })}
              </Text>
              <Text c={isWorkingTestedServer(server) ? "dimmed" : "danger"} size="sm">
                {isWorkingTestedServer(server)
                  ? t("settings.data.pluginVpn.tested.working")
                  : t("settings.data.pluginVpn.tested.failing", { count: server.failures })}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}
