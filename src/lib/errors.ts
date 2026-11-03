export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") return error.message;
    try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
  }
  return String(error);
}
