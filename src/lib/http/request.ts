import { type FetchInitWire, type HttpInit } from "./types";

export function serializeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    // The existing IPC contract has no multipart body representation.
    return undefined;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

export function toWireInit(init: HttpInit): FetchInitWire {
  return {
    method: init.method,
    headers: init.headers ? { ...init.headers } : undefined,
    body: serializeBody(init.body),
  };
}
