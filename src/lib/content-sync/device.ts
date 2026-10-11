import { contentServerRequest, normalizeContentServerUrl } from "./client";

interface ContentCapabilities {
  apiVersion: number;
  packageVersion: number;
  authentication: string;
  personalStateSync: boolean;
}

interface RegisteredDevice { id: string; deviceName: string }

function deviceKeyForServer(server: string): string {
  const storageKey = `norea-content-device:${server}`;
  const saved = localStorage.getItem(storageKey);
  if (saved !== null) {
    if (!/^[a-f0-9]{64}$/.test(saved)) throw new Error("Stored content server device key is invalid.");
    return saved;
  }
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(storageKey, key);
  if (localStorage.getItem(storageKey) !== key) throw new Error("Content server device key could not be saved.");
  return key;
}

const registrations = new Map<string, Promise<string>>();

export function registerContentDevice(serverUrl: string, deviceName: string, signal?: AbortSignal): Promise<string> {
  const server = normalizeContentServerUrl(serverUrl);
  const pending = signal ? undefined : registrations.get(server);
  if (pending) return pending;
  const registration = (async () => {
    signal?.throwIfAborted();
    const capabilities = await contentServerRequest<ContentCapabilities>(server, "/capabilities", undefined, "GET", undefined, signal);
    signal?.throwIfAborted();
    if (capabilities.apiVersion !== 1 || capabilities.packageVersion !== 1
      || capabilities.authentication !== "device-key" || capabilities.personalStateSync !== false) {
      throw new Error("This content server uses an incompatible authentication or package protocol.");
    }
    // Persist before registration so a failed response cannot create a second device.
    const deviceKey = deviceKeyForServer(server);
    await contentServerRequest<RegisteredDevice>(server, "/devices/register", undefined, "POST", { deviceKey, deviceName }, signal);
    signal?.throwIfAborted();
    return deviceKey;
  })().finally(() => { if (!signal) registrations.delete(server); });
  if (!signal) registrations.set(server, registration);
  return registration;
}
