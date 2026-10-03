import { invoke } from "@tauri-apps/api/core";
import { requestAbortedError } from "../abort";
import { withNetworkRequest } from "../network";
import { redactUrlForLog } from "../url-log";
import { serializeBody } from "./request";
import { type HttpInit } from "./types";

interface AppFetchSendResult {
  status: number;
  statusText: string;
  url: string;
  headers: HeadersInit;
  rid: number;
}

const EMPTY_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function encodeAppFetchBody(body: unknown): number[] | null {
  const serialized = serializeBody(body);
  if (serialized === undefined) return null;
  return Array.from(new TextEncoder().encode(serialized));
}

function appFetchHeaders(
  headers: Record<string, string> | undefined,
): [string, string][] {
  return Object.entries(headers ?? {});
}

function concatChunks(
  chunks: Uint8Array<ArrayBuffer>[],
): Uint8Array<ArrayBuffer> {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readAppFetchBody(rid: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  while (true) {
    if (signal.aborted) throw requestAbortedError();
    const data = await invoke<number[]>("plugin:http|fetch_read_body", {
      rid,
    });
    const bytes = new Uint8Array(data);
    if (bytes.byteLength === 0) {
      throw new Error("App fetch body chunk is missing the completion flag.");
    }
    const done = bytes[bytes.byteLength - 1] === 1;
    const chunk = bytes.slice(0, bytes.byteLength - 1);
    if (chunk.byteLength > 0) chunks.push(chunk);
    if (done) break;
  }
  return concatChunks(chunks);
}

export async function appFetch(
  url: string,
  init: HttpInit = {},
): Promise<Response> {
  return withNetworkRequest(init.signal, async (signal) => {
    let requestRid: number | null = null;
    let bodyRid: number | null = null;
    const cancel = () => {
      const command = bodyRid !== null ? "plugin:http|fetch_cancel_body" : "plugin:http|fetch_cancel";
      const rid = bodyRid ?? requestRid;
      bodyRid = null;
      requestRid = null;
      if (rid !== null) {
        void invoke(command, { rid }).catch((error: unknown) => {
          console.warn("[app-fetch] request cancellation failed", error);
        });
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      requestRid = await invoke<number>("plugin:http|fetch", {
        clientConfig: {
          method: init.method ?? "GET", url,
          headers: appFetchHeaders(init.headers), data: encodeAppFetchBody(init.body),
        },
      });
      if (signal.aborted) { cancel(); throw requestAbortedError(); }
      const result = await invoke<AppFetchSendResult>("plugin:http|fetch_send", { rid: requestRid });
      requestRid = null;
      bodyRid = result.rid;
      if (signal.aborted) { cancel(); throw requestAbortedError(); }
      let body: BodyInit | null = null;
      if (!EMPTY_BODY_STATUS.has(result.status)) {
        body = new Blob([await readAppFetchBody(result.rid, signal)]);
        bodyRid = null;
      }
      const response = new Response(body, {
        status: result.status, statusText: result.statusText, headers: result.headers,
      });
      Object.defineProperty(response, "url", { value: result.url, configurable: true });
      return response;
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
    }
  });
}

export async function appFetchText(
  url: string,
  init: HttpInit = {},
): Promise<string> {
  const response = await appFetch(url, init);
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} on ${redactUrlForLog(url)}`,
    );
  }
  return response.text();
}
