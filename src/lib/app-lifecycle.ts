import { isAndroidRuntime } from "./tauri-runtime";

export type AppSuspendHookPhase = "flush" | "drain";

const SUSPEND_HOOK_TIMEOUT_MS = 3_000;

const flushHooks = new Set<() => void | Promise<void>>();
const drainHooks = new Set<() => void | Promise<void>>();

function androidAppActiveBridge(): (() => boolean) | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = window.__NoreaAndroidTasks as { isAppActive?: () => boolean } | undefined;
  return typeof candidate?.isAppActive === "function" ? candidate.isAppActive.bind(candidate) : undefined;
}

/**
 * True while the app window is genuinely active in the foreground.
 *
 * On Android, the foreground service keeps the WebView reporting `View.VISIBLE`
 * (`document.visibilityState === "visible"`) while the screen is off so Blink
 * does not freeze background work. Reading the native activity resumed state
 * keeps foreground-only schedulers from mistaking that survival hook for real
 * foreground activity.
 */
export function isAppActive(): boolean {
  if (isAndroidRuntime()) {
    const nativeActive = androidAppActiveBridge();
    if (nativeActive) return nativeActive() === true;
  }
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function subscribeAppLifecycle(
  listener: (active: boolean) => void,
): () => void {
  if (isAndroidRuntime()) {
    if (typeof window === "undefined") return () => undefined;
    const onResumed = () => listener(true);
    const onPaused = () => listener(false);
    window.addEventListener("norea-app-resumed", onResumed);
    window.addEventListener("norea-app-paused", onPaused);
    return () => {
      window.removeEventListener("norea-app-resumed", onResumed);
      window.removeEventListener("norea-app-paused", onPaused);
    };
  }
  if (typeof document === "undefined") return () => undefined;
  const onVisibilityChange = () => listener(document.visibilityState !== "hidden");
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * Registers a hook run when the app transitions to inactive before background
 * upload checks. `"flush"` hooks run first (e.g. flushing debounced reader
 * state into write queues); `"drain"` hooks run next (e.g. awaiting committed
 * SQLite writes).
 */
export function registerBeforeAppSuspend(
  hook: () => void | Promise<void>,
  phase: AppSuspendHookPhase = "flush",
): () => void {
  const registry = phase === "flush" ? flushHooks : drainHooks;
  registry.add(hook);
  return () => {
    registry.delete(hook);
  };
}

async function runHookPhase(
  hooks: ReadonlySet<() => void | Promise<void>>,
  timeoutMs: number,
): Promise<void> {
  if (hooks.size === 0) return;
  const executions = [...hooks].map((hook) =>
    Promise.resolve()
      .then(() => hook())
      .catch(() => undefined),
  );
  const all = Promise.all(executions).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([all, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runBeforeAppSuspend(timeoutMs = SUSPEND_HOOK_TIMEOUT_MS): Promise<void> {
  await runHookPhase(flushHooks, timeoutMs);
  await runHookPhase(drainHooks, timeoutMs);
}
