import { restorePluginVpnConnection, type PluginVpnStatus } from "./plugin-vpn";

interface PluginVpnLifecycleCallbacks {
  onRestored: (status: PluginVpnStatus) => void;
  onError: (error: unknown) => void;
}

export function startPluginVpnLifecycle({
  onRestored,
  onError,
}: PluginVpnLifecycleCallbacks): () => void {
  let active = true;
  let restoring = false;
  const restore = () => {
    if (!active || restoring) return;
    restoring = true;
    void restorePluginVpnConnection().then(
      (status) => {
        restoring = false;
        if (active && status) onRestored(status);
      },
      (error: unknown) => {
        restoring = false;
        if (active) onError(error);
      },
    );
  };
  const foreground = () => {
    if (document.visibilityState !== "hidden") restore();
  };
  document.addEventListener("visibilitychange", foreground);
  window.addEventListener("focus", foreground);
  window.addEventListener("norea-app-resumed", restore);
  restore();
  return () => {
    active = false;
    document.removeEventListener("visibilitychange", foreground);
    window.removeEventListener("focus", foreground);
    window.removeEventListener("norea-app-resumed", restore);
  };
}
