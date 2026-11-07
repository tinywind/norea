export class HttpStatusError extends Error {
  readonly code = "http-status-error";

  constructor(readonly status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.name = "HttpStatusError";
  }
}

/** Reads an HTTP failure status without treating URL paths or database codes as statuses. */
export function errorHttpStatus(error: unknown): number | undefined {
  if (error !== null && typeof error === "object") {
    if ("name" in error && error.name === "AbortError") return undefined;
    if ("code" in error && error.code === "chapter-media-finalization-failed") return undefined;
    const value = error as { status?: unknown; statusCode?: unknown; message?: unknown };
    if ("code" in error && typeof error.code === "string" && /storage|SQLITE/i.test(error.code)) return undefined;
    if ("code" in error && error.code === "chapter-media-incomplete" && "failures" in error && Array.isArray(error.failures)) {
      return error.failures.length > 0 && error.failures.every(isHttpNotFoundError) ? 404 : undefined;
    }
    const status = value.status ?? value.statusCode;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  const message = typeof error === "string" ? error
    : error !== null && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
  const diagnostic = message.replace(/https?:\/\/\S+/gi, "");
  const match = /(?:^|[\s(])(?:HTTP|status(?: code)?)\s*:?\s*(\d{3})\b/i.exec(diagnostic);
  const legacy = /fetch|request|gateway|not found|forbidden/i.test(diagnostic)
    ? /(?:^|\s)\((\d{3})\)/.exec(diagnostic) : null;
  const status = Number(match?.[1] ?? legacy?.[1]);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

export function isHttpNotFoundError(error: unknown): boolean {
  return errorHttpStatus(error) === 404;
}
