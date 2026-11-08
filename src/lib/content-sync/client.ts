import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { isAbortError } from "../abort";

export class ContentServerError extends Error {
  readonly code = "content-server-request-failed";
  constructor(public status: number, message = `Content server request failed (${status}).`) {
    super(message);
  }
}

/** A retryable failure of the server connection or its own lookup deadline. */
export class ContentServerTransportError extends Error {
  readonly code = "content-server-request-failed";
  readonly retryable = true;

  constructor(message = "The content server connection failed.", options?: ErrorOptions) {
    super(message, options);
    this.name = "ContentServerTransportError";
  }
}

/** Keep request validation, HTTP responses and body parsing outside transport classification. */
export async function contentServerFetch(url: string, init?: Parameters<typeof nativeFetch>[1]): Promise<Response> {
  init?.signal?.throwIfAborted();
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Content server requests require an HTTP(S) URL without credentials.");
  }
  const request = new Request(url, init);
  try {
    return await nativeFetch(request.url, init);
  } catch (cause) {
    if (init?.signal?.aborted) throw init.signal.reason;
    if (isAbortError(cause) || cause instanceof ContentServerError || cause instanceof ContentServerTransportError) throw cause;
    throw new ContentServerTransportError(undefined, { cause });
  }
}

export function normalizeContentServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Content server URL must be an HTTP(S) URL without credentials, query or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function withContentServerLookup<T>(run: (signal: AbortSignal) => Promise<T>, seconds: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const deadline = controller.signal;
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new ContentServerTransportError("Content server lookup timed out.")), seconds * 1000);
  let abort: () => void = () => undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(deadline.reason);
      deadline.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([run(deadline), interrupted]);
  } finally {
    clearTimeout(timer);
    deadline.removeEventListener("abort", abort);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function contentServerRequest<T>(serverUrl: string, path: string, token?: string, method = "GET", body?: unknown, signal?: AbortSignal, timeoutSeconds = 30): Promise<T> {
  return withContentServerLookup(async deadline => {
    const response = await contentServerFetch(`${normalizeContentServerUrl(serverUrl)}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      connectTimeout: 10_000,
      maxRedirections: 0,
      signal: deadline,
    });
    if (!response.ok) {
      if (response.status === 401 && token) {
        const { forgetContentDeviceRegistration } = await import("./device");
        forgetContentDeviceRegistration(serverUrl, token);
      }
      let message: string | undefined;
      if (response.status === 409 && /^\/works\/[^/]+\/(?:finalize-migration|migration-snapshot|reconcile-chapter-numbers|chapter-number-mappings)$/.test(path)) {
        const detail = await response.json().catch(() => null) as { message?: unknown } | null;
        if (typeof detail?.message === "string" && (detail.message.startsWith("Work migration: ") || detail.message.startsWith("Chapter number reconciliation conflict: "))) message = detail.message.slice(0, 1500);
      }
      throw new ContentServerError(response.status, message);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }, timeoutSeconds, signal);
}
