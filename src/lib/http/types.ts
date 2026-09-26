import { type ScraperExecutorId } from "../tasks/scraper-queue";

export type PluginFetchPriority =
  | "interactive"
  | "user"
  | "normal"
  | "deferred"
  | "background";

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  /**
   * Anything plugin code passes through `fetchApi`. The IPC layer
   * needs a string, so non-string values get serialized in
   * `serializeBody` before they cross the boundary. Plain objects
   * become JSON, URLSearchParams becomes their query-string form,
   * and FormData is dropped to undefined until multipart support
   * lands.
   */
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PluginFetchContext {
  contextUrl?: string;
  sourceAccessUrl?: string;
  sourceId?: string;
  scraperExecutor?: ScraperExecutorId;
  /** Internal absolute deadline shared across media retries; never sent to a source. */
  vpnReadyDeadline?: number;
  priority?: PluginFetchPriority;
}

export type PluginHttpInit = HttpInit & PluginFetchContext;

export type ContextUrlProvider = string | (() => string);

export interface FetchInitWire {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResultWire {
  status: number;
  statusText: string;
  body?: string;
  bodyBase64?: string;
  cloudflareChallenge?: boolean;
  headers: Record<string, string>;
  finalUrl: string;
}

export interface CapturedMediaHandle {
  bodyBytes: number;
  bodyHandle: string;
  cloudflareChallenge?: boolean;
  finalUrl: string;
  headers: Record<string, string>;
  status: number;
  statusText: string;
}
