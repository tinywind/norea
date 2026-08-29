import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
  type AndroidStorageTempFile,
} from "./android-storage";
import { androidBridgeAuthority } from "./android-bridge";
import { isAndroidRuntime } from "./tauri-runtime";

const MAX_OPENVPN_PROFILE_BYTES = 1024 * 1024;
const PLUGIN_VPN_STATUS_EVENT = "plugin-vpn-status";
const VPN_PROXY_CONFIGURE_CAPABILITY = "vpn.proxy.configure";

export const PLUGIN_VPN_QUERY_KEY = ["plugin-vpn"] as const;

export type PluginVpnPhase =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "error";

export interface PluginVpnProfile {
  isVpnGateFinder: boolean;
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

export function pluginVpnFinderProfileIp(
  profile: PluginVpnProfile | null | undefined,
): string | null {
  return profile?.isVpnGateFinder ? profile.remoteHost : null;
}

export interface PluginVpnStatusEvent {
  kind: "error" | "reconnected" | "reconnecting";
  status: PluginVpnStatus;
}

export function shouldShowPluginVpnReconnectedToast(
  event: PluginVpnStatusEvent,
): boolean {
  return event.kind === "reconnected" && event.status.phase === "connected";
}

export interface PluginVpnCredentials {
  challengeResponse: string;
  password: string;
  privateKeyPassword: string;
  username: string;
}

export class PluginVpnConnectionNotEstablishedError extends Error {
  constructor() {
    super("Plugin VPN connection did not reach the connected state.");
    this.name = "PluginVpnConnectionNotEstablishedError";
  }
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

export interface PluginVpnFinderSwitchLifecycle {
  isCurrent: () => boolean;
  onConnecting: () => void;
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
    status.profile.isVpnGateFinder ||
    !status.profile.requiresUsernamePassword ||
    (credentials.username.trim() !== "" && credentials.password !== "")
  );
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
let finderQuerySequence = 0;

export function getPluginVpnStatus(): Promise<PluginVpnStatus> {
  return invoke<PluginVpnStatus>("plugin_vpn_status");
}

export function startPluginVpnStatusListener(
  onEvent: (event: PluginVpnStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<PluginVpnStatusEvent>(PLUGIN_VPN_STATUS_EVENT, ({ payload }) => {
    onEvent(payload);
  });
}

export function loadPluginVpnFinderServers(
  forceRefresh = false,
  signal?: AbortSignal,
): Promise<PluginVpnFinderServer[]> {
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("VPN Gate server query was cancelled.", "AbortError"),
    );
  }

  finderQuerySequence += 1;
  const queryId = `${Date.now().toString(36)}-${finderQuerySequence.toString(36)}`;
  const request = invoke<PluginVpnFinderServer[]>("plugin_vpn_load_finder_servers", {
    forceRefresh,
    queryId,
  });
  if (!signal) return request;

  return new Promise((resolve, reject) => {
    let cancellationRequested = false;
    const cancel = () => {
      if (!cancellationRequested) {
        cancellationRequested = true;
        void invoke("plugin_vpn_cancel_finder_query", { queryId }).catch(
          (error: unknown) => {
            console.warn("[plugin-vpn] failed to cancel Finder query", error);
          },
        );
      }
      reject(
        new DOMException("VPN Gate server query was cancelled.", "AbortError"),
      );
    };
    signal.addEventListener("abort", cancel, { once: true });
    void request.then(
      (servers) => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          cancel();
        } else {
          resolve(servers);
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

export function applyPluginVpnFinderProfile(
  candidateId: string,
): Promise<PluginVpnStatus> {
  return invoke<PluginVpnStatus>("plugin_vpn_apply_finder_profile", {
    candidateId,
  });
}

export async function switchPluginVpnFinderServer(
  candidateId: string,
  lifecycle: PluginVpnFinderSwitchLifecycle,
): Promise<PluginVpnStatus | null> {
  await disconnectPluginVpn(true);
  if (!lifecycle.isCurrent()) return null;
  try {
    await applyPluginVpnFinderProfile(candidateId);
  } catch (error) {
    if (lifecycle.isCurrent()) await cancelFailedPluginVpnConnection();
    throw error;
  }
  if (!lifecycle.isCurrent()) return null;
  lifecycle.onConnecting();
  const status = await connectPluginVpn(
    {
      challengeResponse: "",
      password: "",
      privateKeyPassword: "",
      username: "",
    },
    lifecycle.isCurrent,
  );
  return lifecycle.isCurrent() ? status : null;
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

export function connectPluginVpn(
  credentials: PluginVpnCredentials,
): Promise<PluginVpnStatus>;
export function connectPluginVpn(
  credentials: PluginVpnCredentials,
  isCurrent: () => boolean,
): Promise<PluginVpnStatus | null>;
export async function connectPluginVpn(
  credentials: PluginVpnCredentials,
  isCurrent: () => boolean = () => true,
): Promise<PluginVpnStatus | null> {
  await ensureAndroidPluginVpnProxy();
  if (!isCurrent()) return null;

  let status: PluginVpnStatus;
  try {
    status = await invoke<PluginVpnStatus>("plugin_vpn_connect", {
      credentials,
    });
  } catch (error) {
    if (isCurrent()) await cancelFailedPluginVpnConnection();
    throw error;
  }
  if (!isCurrent()) return null;
  if (status.phase !== "connected") {
    await cancelFailedPluginVpnConnection();
    if (status.error) throw new Error(status.error);
    throw new PluginVpnConnectionNotEstablishedError();
  }
  return status;
}

async function cancelFailedPluginVpnConnection(): Promise<void> {
  try {
    await disconnectPluginVpn();
  } catch (error) {
    console.warn("[plugin-vpn] failed connection cleanup failed", error);
  }
}

export function disconnectPluginVpn(
  preserveBlock = false,
): Promise<PluginVpnStatus> {
  return invoke<PluginVpnStatus>("plugin_vpn_disconnect", { preserveBlock });
}

export function removePluginVpnProfile(): Promise<PluginVpnStatus> {
  return invoke<PluginVpnStatus>("plugin_vpn_remove_profile");
}
