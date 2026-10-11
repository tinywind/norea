import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import type { CatalogEntry } from "./native";

export type ContentStateValue =
  | { deleted: boolean }
  | { unread: boolean; progress: number }
  | { chapterPath: string; progress: number; readAt: number | null; locator?: string };

export interface ContentStateEntry {
  key: string;
  version: number;
  value: ContentStateValue;
  conflicts: { operationId: string; deviceName: string; value: ContentStateValue }[];
}
export interface ContentStateMutation {
  key: string;
  baseVersion: number;
  operationId: string;
  deviceName: string;
  value: ContentStateValue;
}
export interface ContentServerUser { id: string; username: string; role: string }
export interface ContentSession { token: string; user: ContentServerUser }

export class ContentServerError extends Error {
  constructor(public status: number, public current?: ContentStateEntry) {
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

export async function contentServerRequest<T>(serverUrl: string, path: string, token?: string, method = "GET", body?: unknown): Promise<T> {
  const response = await nativeFetch(`${normalizeContentServerUrl(serverUrl)}/api/v1${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    connectTimeout: 10_000,
    maxRedirections: 0,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const payload = response.status === 409 ? await response.json().catch(() => null) : null;
    throw new ContentServerError(response.status, payload?.current ?? (payload?.key ? payload : undefined));
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export interface ContentCatalogPage { items: CatalogEntry[]; cursor: number; hasMore: boolean }
