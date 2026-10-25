import { invoke } from "@tauri-apps/api/core";
import { contentServerRequest, normalizeContentServerUrl } from "./client";

export interface ContentCapabilities {
  apiVersion: number;
  packageVersion: number;
  authentication: string;
  personalStateSync: boolean;
  readingStateVersion?: number;
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
const registeredDevices = new Map<string, { deviceName: string; deviceKey: string }>();

export function forgetContentDeviceRegistration(serverUrl: string, deviceKey: string): void {
  const server = normalizeContentServerUrl(serverUrl);
  if (registeredDevices.get(server)?.deviceKey === deviceKey) registeredDevices.delete(server);
}

export function registerContentDevice(serverUrl: string, deviceName: string, signal?: AbortSignal): Promise<string> {
  const server = normalizeContentServerUrl(serverUrl);
  if (signal?.aborted) return Promise.reject(signal.reason);
  const registered = registeredDevices.get(server);
  if (registered?.deviceName === deviceName && localStorage.getItem(`norea-content-device:${server}`) === registered.deviceKey) {
    return Promise.resolve(registered.deviceKey).then(key => { signal?.throwIfAborted(); return key; });
  }
  const registrationKey = JSON.stringify([server, deviceName]);
  const pending = signal ? undefined : registrations.get(registrationKey);
  if (pending) return pending;
  const registration = (async () => {
    const registrationName = deviceName || await invoke<string>("get_default_device_name");
    signal?.throwIfAborted();
    const capabilities = await contentServerRequest<ContentCapabilities>(server, "/capabilities", undefined, "GET", undefined, signal);
    signal?.throwIfAborted();
    if (capabilities.apiVersion !== 1 || capabilities.packageVersion !== 1
      || capabilities.authentication !== "device-key"
      || (capabilities.personalStateSync !== false && !(capabilities.personalStateSync === true && capabilities.readingStateVersion === 1))) {
      throw new Error("This content server uses an incompatible authentication or package protocol.");
    }
    // Persist before registration so a failed response cannot create a second device.
    const deviceKey = deviceKeyForServer(server);
    await contentServerRequest<RegisteredDevice>(server, "/devices/register", undefined, "POST", { deviceKey, deviceName: registrationName }, signal);
    signal?.throwIfAborted();
    registeredDevices.set(server, { deviceName, deviceKey });
    return deviceKey;
  })().finally(() => { if (!signal) registrations.delete(registrationKey); });
  if (!signal) registrations.set(registrationKey, registration);
  return registration;
}
