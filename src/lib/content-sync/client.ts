import { fetch as nativeFetch } from "@tauri-apps/plugin-http";

export class ContentServerError extends Error {
  constructor(public status: number, message = `Content server request failed (${status}).`) {
    super(message);
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
  const timer = setTimeout(() => controller.abort(new Error("Content server lookup timed out.")), seconds * 1000);
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

export async function contentServerRequest<T>(serverUrl: string, path: string, token?: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  return withContentServerLookup(async deadline => {
    const response = await nativeFetch(`${normalizeContentServerUrl(serverUrl)}/api/v1${path}`, {
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
      throw new ContentServerError(response.status);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }, 30, signal);
}
