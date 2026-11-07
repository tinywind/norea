import { redactUrlsForLog } from "../url-log";

export interface DownloadFailureStops {
  sourceErrors: Record<string, string>;
  globalError?: string;
}

interface DownloadFailureStopStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface DownloadFailureStopScheduler {
  getDownloadFailureStops: () => DownloadFailureStops;
  hydrateDownloadFailureStops: (stops: DownloadFailureStops) => void;
  subscribe: (listener: () => void) => () => void;
}

export const DOWNLOAD_FAILURE_STOP_STORAGE_KEY = "download-failure-stops";
const STORAGE_VERSION = 1;
const MAX_MESSAGE_LENGTH = 300;
const MAX_STORAGE_LENGTH = 1_048_576;

function defaultStorage(): DownloadFailureStopStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validSourceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value) &&
    value !== "constructor" && value !== "prototype";
}

function messageSummary(value: unknown, persisted: boolean): string | undefined {
  if (typeof value !== "string" || (persisted && value.length > MAX_MESSAGE_LENGTH)) return undefined;
  const message = redactUrlsForLog(value).replace(/\s+/g, " ").trim();
  if (!message) return undefined;
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : message;
}

function normalizedStops(value: unknown, persisted: boolean): DownloadFailureStops {
  const stops: DownloadFailureStops = { sourceErrors: {} };
  if (!isRecord(value) || !isRecord(value.sourceErrors)) return stops;
  for (const [sourceId, error] of Object.entries(value.sourceErrors)) {
    if (!validSourceId(sourceId)) continue;
    const message = messageSummary(error, persisted);
    if (message) stops.sourceErrors[sourceId] = message;
  }
  const globalError = messageSummary(value.globalError, persisted);
  if (globalError) stops.globalError = globalError;
  return stops;
}

export function loadPersistedDownloadFailureStops(
  storage: DownloadFailureStopStorage | null = defaultStorage(),
): DownloadFailureStops {
  try {
    const raw = storage?.getItem(DOWNLOAD_FAILURE_STOP_STORAGE_KEY);
    if (!raw || raw.length > MAX_STORAGE_LENGTH) return { sourceErrors: {} };
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== STORAGE_VERSION) return { sourceErrors: {} };
    return normalizedStops(value, true);
  } catch {
    return { sourceErrors: {} };
  }
}

export function initializeDownloadFailureStopPersistence(
  scheduler: DownloadFailureStopScheduler,
  storage: DownloadFailureStopStorage | null = defaultStorage(),
): () => void {
  scheduler.hydrateDownloadFailureStops(loadPersistedDownloadFailureStops(storage));
  let previous = "";
  const persist = () => {
    if (!storage) return;
    const serialized = JSON.stringify({ version: STORAGE_VERSION, ...normalizedStops(scheduler.getDownloadFailureStops(), false) });
    if (serialized === previous) return;
    try {
      storage.setItem(DOWNLOAD_FAILURE_STOP_STORAGE_KEY, serialized);
      previous = serialized;
    } catch {
      // The scheduler keeps the stop enforced when storage is unavailable.
    }
  };
  persist();
  return scheduler.subscribe(persist);
}
