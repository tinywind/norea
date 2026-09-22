import { Button, Paper, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { translate } from "../../i18n";
import { describeError } from "../../lib/errors";
import {
  ensureAndroidPluginVpnProxy,
  PLUGIN_VPN_QUERY_KEY,
  shouldShowPluginVpnReconnectedToast,
  startPluginVpnStatusListener,
  type PluginVpnStatusEvent,
} from "../../lib/plugin-vpn";
import { startPluginVpnLifecycle } from "../../lib/plugin-vpn-lifecycle";
import { showErrorToast } from "../../lib/runtime/error-toast";
import { isAndroidRuntime, isTauriRuntime } from "../../lib/tauri-runtime";
import { useAppearanceStore } from "../../store/appearance";

export function PluginVpnProxyGate({ children }: { children: ReactNode }) {
  const appLocale = useAppearanceStore((state) => state.appLocale);
  const queryClient = useQueryClient();
  const android = isAndroidRuntime();
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(android);
  const [ready, setReady] = useState(!android);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!android) return;
    let cancelled = false;
    setChecking(true);
    setError(null);
    void ensureAndroidPluginVpnProxy()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((unknownError: unknown) => {
        if (cancelled) return;
        setReady(false);
        setError(describeError(unknownError));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [android, attempt]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    const onStatusEvent = (event: PluginVpnStatusEvent) => {
      if (!active) return;
      queryClient.setQueryData(PLUGIN_VPN_QUERY_KEY, event.status);
      if (shouldShowPluginVpnReconnectedToast(event)) {
        const eventLocale = useAppearanceStore.getState().appLocale;
        notifications.show({
          autoClose: 3_000,
          color: "green",
          message: translate(
            eventLocale,
            "settings.data.pluginVpn.toast.reconnected",
          ),
          title: translate(eventLocale, "settings.data.pluginVpn.title"),
        });
      }
    };
    const stopRecovery = startPluginVpnLifecycle({
      onRestored: (status) => onStatusEvent({ kind: "reconnected", status }),
      onError: (error) => {
        console.warn("[plugin-vpn] automatic reconnection failed", error);
        void queryClient.invalidateQueries({ queryKey: PLUGIN_VPN_QUERY_KEY });
        showErrorToast(
          translate(
            useAppearanceStore.getState().appLocale,
            "settings.data.pluginVpn.title",
          ),
          error,
        );
      },
    });
    void startPluginVpnStatusListener(onStatusEvent)
      .then((cleanup) => {
        if (active) {
          unlisten = cleanup;
        } else {
          cleanup();
        }
      })
      .catch((error: unknown) => {
        console.warn("[plugin-vpn] failed to listen for status events", error);
      });

    return () => {
      active = false;
      stopRecovery();
      unlisten?.();
    };
  }, [queryClient]);

  if (!android || ready) return children;
  return (
    <div className="norea-storage-setup">
      <Paper className="norea-storage-setup-card" withBorder>
        <Stack gap="md">
          <Stack gap="xs">
            <Title order={1} className="norea-storage-setup-title">
              {translate(appLocale, "pluginVpn.bootstrap.title")}
            </Title>
            <Text className="norea-storage-setup-copy">
              {translate(appLocale, "pluginVpn.bootstrap.description")}
            </Text>
          </Stack>
          {error ? (
            <Text className="norea-storage-setup-error" role="alert">
              {translate(appLocale, "pluginVpn.bootstrap.failed", { error })}
            </Text>
          ) : null}
          <Button
            loading={checking}
            onClick={() => {
              setAttempt((value) => value + 1);
            }}
          >
            {translate(appLocale, "pluginVpn.bootstrap.retry")}
          </Button>
        </Stack>
      </Paper>
    </div>
  );
}
