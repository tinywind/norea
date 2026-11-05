import { translate } from "../i18n";
import { useAppearanceStore } from "../store/appearance";
import { usePluginVpnStore } from "../store/plugin-vpn";
import {
  getPluginVpnStatus,
  isPluginVpnRecoveryStopped,
  isRetryablePluginVpnError,
  PLUGIN_VPN_CONNECTION_SETTLED_EVENT,
  PLUGIN_VPN_PROFILE_RELEASED_EVENT,
  startPluginVpnStatusListener,
  type PluginVpnStatus,
} from "./plugin-vpn";
import { isAndroidRuntime } from "./tauri-runtime";

interface AndroidPluginVpnKeepAliveBridge {
  update: (payload: string) => void;
}

declare global {
  interface Window {
    __NoreaAndroidPluginVpnKeepAlive?: AndroidPluginVpnKeepAliveBridge;
  }
}

/**
 * True while the user's plugin VPN request still expects a tunnel, including the
 * disconnected gaps that automatic recovery bridges. Turning the VPN off, a
 * released recovery profile, a removed profile, or a non-retryable failure ends it.
 */
export function shouldKeepPluginVpnAlive(
  enabled: boolean,
  recoveryStopped: boolean,
  status: PluginVpnStatus,
): boolean {
  if (!enabled || recoveryStopped || !status.supported || !status.profile) return false;
  return status.error === null || isRetryablePluginVpnError(status.error);
}

/**
 * Runs the Android plugin VPN foreground service while the VPN is on, because
 * Android blocks a background app's network and the tunnel would close.
 */
export function startAndroidPluginVpnKeepAlive(): () => void {
  if (!isAndroidRuntime()) return () => undefined;

  let active = true;
  let revision = 0;
  let lastPayload = "";
  let stopStatusListener: (() => void) | null = null;

  const publish = (payload: object) => {
    const bridge = window.__NoreaAndroidPluginVpnKeepAlive;
    if (!bridge) return;
    const serialized = JSON.stringify(payload);
    if (serialized === lastPayload) return;
    bridge.update(serialized);
    lastPayload = serialized;
  };
  const sync = () => {
    const current = ++revision;
    void getPluginVpnStatus().then(
      (status) => {
        if (!active || current !== revision) return;
        const keepAlive = shouldKeepPluginVpnAlive(
          usePluginVpnStore.getState().enabled,
          isPluginVpnRecoveryStopped(),
          status,
        );
        const locale = useAppearanceStore.getState().appLocale;
        publish(keepAlive ? {
          active: true,
          title: translate(locale, "pluginVpn.notification.title"),
          body: status.profile?.remoteHost ?? "",
          channelName: translate(locale, "pluginVpn.notification.channel"),
          channelDescription: translate(locale, "pluginVpn.notification.channelDescription"),
        } : { active: false });
      },
      (error: unknown) => {
        console.warn("[plugin-vpn] keep-alive status check failed", error);
      },
    );
  };
  // Android refuses a foreground service start from the background; retry it in the foreground.
  const resync = () => {
    lastPayload = "";
    sync();
  };

  const stopIntentListener = usePluginVpnStore.subscribe(sync);
  const stopLocaleListener = useAppearanceStore.subscribe((state, previous) => {
    if (state.appLocale !== previous.appLocale) sync();
  });
  window.addEventListener(PLUGIN_VPN_CONNECTION_SETTLED_EVENT, sync);
  window.addEventListener(PLUGIN_VPN_PROFILE_RELEASED_EVENT, sync);
  window.addEventListener("norea-app-resumed", resync);
  void startPluginVpnStatusListener(sync).then(
    (unlisten) => {
      if (active) stopStatusListener = unlisten;
      else unlisten();
    },
    (error: unknown) => {
      console.warn("[plugin-vpn] failed to watch status for the keep-alive service", error);
    },
  );
  sync();

  return () => {
    active = false;
    stopStatusListener?.();
    stopIntentListener();
    stopLocaleListener();
    window.removeEventListener(PLUGIN_VPN_CONNECTION_SETTLED_EVENT, sync);
    window.removeEventListener(PLUGIN_VPN_PROFILE_RELEASED_EVENT, sync);
    window.removeEventListener("norea-app-resumed", resync);
    publish({ active: false });
  };
}
