import { invoke } from "@tauri-apps/api/core";
import { contentServerRequest, normalizeContentServerUrl } from "./client";

export interface ContentCapabilities {
  apiVersion: number;
  packageVersion: number;
  authentication: string;
  personalStateSync: boolean;
  readingStateVersion?: number;
  userStateVersion?: number;
  userStateBulkVersion?: number;
  userStateOpaqueIdentityVersion?: number;
  userStateRetentionVersion?: number;
  userStateCurrentVersion?: number;
  workDeleteIdentityCheckVersion?: number;
  workCatalogSummaryVersion?: number;
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

interface PendingRegistration {
  controller: AbortController;
  request: Promise<string>;
  waiters: number;
  unabortable: boolean;
}
const registrations = new Map<string, PendingRegistration>();
const registeredDevices = new Map<string, { deviceName: string; deviceKey: string }>();
const capabilitiesByServer = new Map<string, { capabilities: ContentCapabilities; expiresAt: number }>();

export function forgetContentServerCapabilities(serverUrl: string): void {
  capabilitiesByServer.delete(normalizeContentServerUrl(serverUrl));
}

async function fetchCapabilities(server: string, signal?: AbortSignal): Promise<ContentCapabilities> {
  const capabilities = await contentServerRequest<ContentCapabilities>(server, "/capabilities", undefined, "GET", undefined, signal);
  signal?.throwIfAborted();
  capabilitiesByServer.set(server, { capabilities, expiresAt: Date.now() + 5 * 60_000 });
  return capabilities;
}

export async function getContentServerCapabilities(serverUrl: string, signal?: AbortSignal): Promise<ContentCapabilities> {
  signal?.throwIfAborted();
  const server = normalizeContentServerUrl(serverUrl);
  const cached = capabilitiesByServer.get(server);
  return cached && Date.now() < cached.expiresAt ? cached.capabilities : fetchCapabilities(server, signal);
}

export function forgetContentDeviceRegistration(serverUrl: string, deviceKey: string): void {
  const server = normalizeContentServerUrl(serverUrl);
  if (registeredDevices.get(server)?.deviceKey === deviceKey) registeredDevices.delete(server);
  capabilitiesByServer.delete(server);
}

export function registerContentDevice(serverUrl: string, deviceName: string, signal?: AbortSignal): Promise<string> {
  const server = normalizeContentServerUrl(serverUrl);
  if (signal?.aborted) return Promise.reject(signal.reason);
  const registered = registeredDevices.get(server);
  if (registered?.deviceName === deviceName && localStorage.getItem(`norea-content-device:${server}`) === registered.deviceKey) {
    return Promise.resolve(registered.deviceKey).then(key => { signal?.throwIfAborted(); return key; });
  }
  const registrationKey = JSON.stringify([server, deviceName]);
  let pending = registrations.get(registrationKey);
  if (!pending || pending.controller.signal.aborted) {
    const controller = new AbortController();
    const request = Promise.resolve().then(async () => {
      const shared = controller.signal;
      shared.throwIfAborted();
      const registrationName = deviceName || await invoke<string>("get_default_device_name");
      shared.throwIfAborted();
      const capabilities = await fetchCapabilities(server, shared);
      if (capabilities.apiVersion !== 1 || capabilities.packageVersion !== 1
        || capabilities.authentication !== "device-key"
        || (capabilities.personalStateSync !== false && !(capabilities.personalStateSync === true && (capabilities.readingStateVersion === 1 || capabilities.userStateVersion === 1 || capabilities.userStateCurrentVersion === 2)))) {
        throw new Error("This content server uses an incompatible authentication or package protocol.");
      }
      // Persist before registration so a failed response cannot create a second device.
      shared.throwIfAborted();
      const deviceKey = deviceKeyForServer(server);
      await contentServerRequest<RegisteredDevice>(server, "/devices/register", undefined, "POST", { deviceKey, deviceName: registrationName }, shared);
      shared.throwIfAborted();
      registeredDevices.set(server, { deviceName, deviceKey });
      return deviceKey;
    }).finally(() => {
      if (registrations.get(registrationKey)?.controller === controller) registrations.delete(registrationKey);
    });
    pending = { controller, request, waiters: 0, unabortable: false };
    registrations.set(registrationKey, pending);
  }
  const registration = pending;
  if (!signal) {
    registration.unabortable = true;
    return registration.request;
  }
  registration.waiters++;
  return new Promise((resolve, reject) => {
    const release = () => {
      signal.removeEventListener("abort", abort);
      registration.waiters--;
    };
    const abort = () => {
      release();
      if (!registration.waiters && !registration.unabortable) registration.controller.abort(signal.reason);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    registration.request.then(
      key => { if (!signal.aborted) { release(); resolve(key); } },
      error => { if (!signal.aborted) { release(); reject(error); } },
    );
  });
}
