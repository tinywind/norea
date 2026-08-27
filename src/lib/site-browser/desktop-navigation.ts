import { invoke } from "@tauri-apps/api/core";

export interface DesktopNavigationArgs {
  url: string;
  userAgent: string | null;
  resetHistory: boolean;
  sourceId: string;
  timeoutMs: number | null;
}

function navigationAbortedError(): DOMException {
  return new DOMException("Request cancelled", "AbortError");
}

export async function invokeDesktopNavigation(
  args: DesktopNavigationArgs,
  signal?: AbortSignal,
  onCancellationError?: (error: unknown) => void,
): Promise<void> {
  if (signal?.aborted) throw navigationAbortedError();
  const request = invoke<void>("scraper_navigate", { ...args });
  if (!signal) return await request;

  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      void invoke<boolean>("scraper_cancel_executor", {
        message: "Request cancelled",
        queue: "immediate",
      }).catch((error) => onCancellationError?.(error));
      reject(navigationAbortedError());
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });

  try {
    await Promise.race([request, abort]);
  } catch (error) {
    if (signal.aborted) throw navigationAbortedError();
    throw error;
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    request.catch(() => undefined);
  }
}
