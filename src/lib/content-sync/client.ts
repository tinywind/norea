import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import type { CatalogEntry } from "./native";

export class ContentServerError extends Error {
  constructor(public status: number) {
    super(`Content server request failed (${status}).`);
  }
}

export function normalizeContentServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Content server URL must be an HTTP(S) URL without credentials, query or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function contentServerRequest<T>(serverUrl: string, path: string, token?: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await nativeFetch(`${normalizeContentServerUrl(serverUrl)}/api/v1${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    connectTimeout: 10_000,
    maxRedirections: 0,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new ContentServerError(response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export interface ContentCatalogPage { items: CatalogEntry[]; cursor: number; hasMore: boolean }
