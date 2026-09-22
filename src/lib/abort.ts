export const REQUEST_CANCELLED_ERROR = "Request cancelled";

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function requestAbortedError(): DOMException {
  return new DOMException(REQUEST_CANCELLED_ERROR, "AbortError");
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted) {
    throw new DOMException(message, "AbortError");
  }
}
