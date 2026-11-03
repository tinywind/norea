import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./tauri-runtime";

interface FrontendCrash {
  kind: "error" | "unhandledRejection";
  message: string;
  stack?: string;
  url?: string;
}

let installed = false;

function bounded(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - "[truncated]".length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}[truncated]`;
}

function reasonDetails(reason: unknown, fallback: string): Pick<FrontendCrash, "message" | "stack"> {
  if (typeof reason === "string") return { message: reason };
  if (reason !== null && typeof reason === "object") {
    try {
      const detail = reason as { message?: unknown; stack?: unknown };
      if (typeof detail.message === "string") {
        return { message: detail.message, ...(typeof detail.stack === "string" ? { stack: detail.stack } : {}) };
      }
    } catch {}
  }
  if (typeof reason === "number" || typeof reason === "boolean" || typeof reason === "bigint") return { message: String(reason) };
  return { message: `${fallback} (${typeof reason})` };
}

function pageUrl(): string | undefined {
  try { return window.location?.href; } catch { return undefined; }
}

function report(crash: FrontendCrash): void {
  if (!isTauriRuntime()) return;
  try {
    void invoke("record_frontend_crash", {
      crash: {
        kind: crash.kind,
        message: bounded(crash.message, 16_384),
        ...(crash.stack ? { stack: bounded(crash.stack, 262_144) } : {}),
        ...(crash.url ? { url: bounded(crash.url, 4_096) } : {}),
      },
    }).catch(() => undefined);
  } catch {}
}

export function installRuntimeCrashCapture(): void {
  if (installed || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  installed = true;
  window.addEventListener("error", event => {
    try {
      if (!event.message && !event.error) return;
      const details = event.error == null ? { message: event.message } : reasonDetails(event.error, event.message);
      report({ kind: "error", ...details, url: event.filename || pageUrl() });
    } catch { report({ kind: "error", message: "JavaScript error details could not be read", url: pageUrl() }); }
  });
  window.addEventListener("unhandledrejection", event => {
    try { report({ kind: "unhandledRejection", ...reasonDetails(event.reason, "Unhandled promise rejection"), url: pageUrl() }); }
    catch { report({ kind: "unhandledRejection", message: "Unhandled promise rejection details could not be read", url: pageUrl() }); }
  });
}
