import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
  type AndroidStorageTempFile,
} from "./android-storage";
import { androidBridgeAuthority } from "./android-bridge";
import { isAndroidRuntime } from "./tauri-runtime";

const MAX_OPENVPN_PROFILE_BYTES = 1024 * 1024;
const VPN_PROXY_CONFIGURE_CAPABILITY = "vpn.proxy.configure";

export type PluginVpnPhase =
  | "disabled"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

export interface PluginVpnProfile {
  remoteHost: string;
  requiresUsernamePassword: boolean;
}

export interface PluginVpnStatus {
  error: string | null;
  phase: PluginVpnPhase;
  profile: PluginVpnProfile | null;
  proxyPort: number;
  supported: boolean;
}

export interface PluginVpnCredentials {
  challengeResponse: string;
  password: string;
  privateKeyPassword: string;
  username: string;
}

export type PluginVpnServerProtocol = "tcp" | "udp";

export interface PluginVpnFinderServer {
  activeSessions: number;
  candidateId: string;
  countryCode: string;
  countryName: string;
  hostName: string;
  ip: string;
  logType: string;
  pingMs: number | null;
  protocol: PluginVpnServerProtocol;
  score: number;
  speedBps: number;
  totalUsers: number;
  uptimeMs: number;
}

export function canStartPluginVpnConnection(
  status: PluginVpnStatus | undefined,
  credentials: PluginVpnCredentials,
): boolean {
  if (
    !status?.supported ||
    status.phase !== "disabled" ||
    !status.profile
  ) {
    return false;
  }
  return (
    !status.profile.requiresUsernamePassword ||
    (credentials.username.trim() !== "" && credentials.password !== "")
  );
}

export function isPluginVpnControlStatusReady(
  status: PluginVpnStatus | undefined,
  queryPending: boolean,
  queryError: boolean,
): status is PluginVpnStatus {
  return status !== undefined && !queryPending && !queryError;
}

interface AndroidVpnProxyBridge {
  configure: (payload: string) => string;
}

interface AndroidVpnProxyResult {
  error?: string;
  ok?: boolean;
}

declare global {
  interface Window {
    __NoreaAndroidVpn?: AndroidVpnProxyBridge;
  }
}

let androidProxyConfiguration: Promise<void> | null = null;

export function getPluginVpnStatus(): Promise<PluginVpnStatus> {
  return invoke<PluginVpnStatus>("plugin_vpn_status");
}

export function loadPluginVpnFinderServers(
  forceRefresh = false,
): Promise<PluginVpnFinderServer[]> {
  return invoke<PluginVpnFinderServer[]>("plugin_vpn_load_finder_servers", {
    forceRefresh,
  });
}

export function applyPluginVpnFinderProfile(
  candidateId: string,
): Promise<PluginVpnStatus> {
  return invoke<PluginVpnStatus>("plugin_vpn_apply_finder_profile", {
    candidateId,
  });
}

export async function applyAndConnectPluginVpnFinderProfile(
  candidateId: string,
): Promise<PluginVpnStatus> {
  await applyPluginVpnFinderProfile(candidateId);
  return connectPluginVpn({
    challengeResponse: "",
    password: "",
    privateKeyPassword: "",
    username: "",
  });
}

export async function configureAndroidPluginVpnProxy(
  status: PluginVpnStatus,
): Promise<void> {
  if (!isAndroidRuntime()) return;
  if (!status.supported) {
    throw new Error("Plugin VPN is unavailable on this Android build.");
  }
  if (!Number.isInteger(status.proxyPort) || status.proxyPort < 1 || status.proxyPort > 65_535) {
    throw new Error("Plugin VPN proxy port is invalid.");
  }
  const bridge = window.__NoreaAndroidVpn;
  if (!bridge) {
    throw new Error("Android plugin VPN proxy bridge is unavailable.");
  }
  const authority = androidBridgeAuthority(VPN_PROXY_CONFIGURE_CAPABILITY);

  let result: AndroidVpnProxyResult;
  try {
    result = JSON.parse(
      bridge.configure(
        JSON.stringify({
          _bridge: authority,
          port: status.proxyPort,
        }),
      ),
    ) as AndroidVpnProxyResult;
  } catch {
    throw new Error("Android plugin VPN proxy returned an invalid response.");
  }
  if (!result.ok) {
    throw new Error(result.error || "Android plugin VPN proxy configuration failed.");
  }
}

export async function ensureAndroidPluginVpnProxy(): Promise<void> {
  if (!isAndroidRuntime()) return;
  if (!androidProxyConfiguration) {
    const attempt = getPluginVpnStatus().then(configureAndroidPluginVpnProxy);
    const retryable = attempt.catch((error: unknown) => {
      if (androidProxyConfiguration === retryable) {
        androidProxyConfiguration = null;
      }
      throw error;
    });
    androidProxyConfiguration = retryable;
  }
  await androidProxyConfiguration;
}

export async function importPluginVpnProfile(): Promise<PluginVpnStatus | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "OpenVPN", extensions: ["ovpn"] }],
  });
  if (selected === null) return null;
  if (Array.isArray(selected)) {
    throw new Error("OpenVPN profile selection returned multiple files.");
  }

  let tempFile: AndroidStorageTempFile | null = null;
  let path = selected;
  if (isAndroidRuntime() && selected.startsWith("content://")) {
    tempFile = await copyAndroidContentUriToTempFile(
      selected,
      MAX_OPENVPN_PROFILE_BYTES,
    );
    if (!tempFile) {
      throw new Error("Android OpenVPN profile import is unavailable.");
    }
    path = tempFile.path;
  }

  try {
    return await invoke<PluginVpnStatus>("plugin_vpn_import_profile", { path });
  } finally {
    if (tempFile) {
      try {
        await deleteAndroidContentUriTempFile(tempFile);
      } catch (error) {
        console.warn("[plugin-vpn] temp profile cleanup failed", error);
      }
    }
  }
}

export async function connectPluginVpn(
  credentials: PluginVpnCredentials,
): Promise<PluginVpnStatus> {
  await ensureAndroidPluginVpnProxy();
  return invoke<PluginVpnStatus>("plugin_vpn_connect", { credentials });
}

export function disconnectPluginVpn(): Promise<PluginVpnStatus> {
  return invoke<PluginVpnStatus>("plugin_vpn_disconnect");
}

export function removePluginVpnProfile(): Promise<PluginVpnStatus> {
  return invoke<PluginVpnStatus>("plugin_vpn_remove_profile");
}
