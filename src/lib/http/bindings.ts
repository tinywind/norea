import { bytesToBase64Cooperatively } from "../base64";
import { type ScraperExecutorId } from "../tasks/scraper-queue";
import { pluginFetch, pluginFetchText, pluginMediaFetch } from "./plugin-fetch";
import { type ContextUrlProvider, type PluginHttpInit } from "./types";

function resolveContextUrl(
  contextUrl: ContextUrlProvider | undefined,
): string | undefined {
  return typeof contextUrl === "function" ? contextUrl() : contextUrl;
}

export function createPluginFetch(
  contextUrl: ContextUrlProvider,
  sourceId?: string,
  scraperExecutor?: ScraperExecutorId,
): (url: string, init?: PluginHttpInit) => Promise<Response> {
  return (url, init = {}) =>
    pluginFetch(url, {
      ...init,
      contextUrl: init.contextUrl ?? resolveContextUrl(contextUrl),
      sourceId: init.sourceId ?? sourceId,
      scraperExecutor: init.scraperExecutor ?? scraperExecutor,
    });
}

export function createPluginFetchText(
  contextUrl: ContextUrlProvider,
  sourceId?: string,
  scraperExecutor?: ScraperExecutorId,
): (url: string, init?: PluginHttpInit) => Promise<string> {
  return (url, init = {}) =>
    pluginFetchText(url, {
      ...init,
      contextUrl: init.contextUrl ?? resolveContextUrl(contextUrl),
      sourceId: init.sourceId ?? sourceId,
      scraperExecutor: init.scraperExecutor ?? scraperExecutor,
    });
}

export function createPluginFetchFile(
  contextUrl?: ContextUrlProvider,
  sourceId?: string,
  scraperExecutor?: ScraperExecutorId,
): (url: string, init?: PluginHttpInit) => Promise<string> {
  return async (url, init = {}) => {
    const response = await pluginMediaFetch(url, {
      ...init,
      contextUrl:
        init.contextUrl ??
        (contextUrl === undefined ? undefined : resolveContextUrl(contextUrl)),
      sourceId: init.sourceId ?? sourceId,
      scraperExecutor: init.scraperExecutor ?? scraperExecutor,
    });
    if (!response.ok) return "";
    return bytesToBase64Cooperatively(
      new Uint8Array(await response.arrayBuffer()),
    );
  };
}

function normalizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const obj: Record<string, string> = {};
    headers.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  }
  if (Array.isArray(headers)) {
    const obj: Record<string, string> = {};
    for (const [key, value] of headers) {
      obj[key] = value;
    }
    return obj;
  }
  return headers as Record<string, string>;
}

export function pluginFetchShim(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return createPluginFetchShim()(input, init);
}

export function createPluginFetchShim(
  contextUrl?: ContextUrlProvider,
  sourceId?: string,
  scraperExecutor?: ScraperExecutorId,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const pluginInit = init as
      | (RequestInit & {
          contextUrl?: string;
          scraperExecutor?: ScraperExecutorId;
          sourceId?: string;
          timeoutMs?: number;
        })
      | undefined;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return pluginFetch(url, {
      method: pluginInit?.method,
      headers: normalizeHeaders(pluginInit?.headers),
      body: pluginInit?.body,
      contextUrl: pluginInit?.contextUrl ?? resolveContextUrl(contextUrl),
      sourceId: pluginInit?.sourceId ?? sourceId,
      scraperExecutor: pluginInit?.scraperExecutor ?? scraperExecutor,
      timeoutMs: pluginInit?.timeoutMs,
      signal: pluginInit?.signal ?? undefined,
    });
  };
}
