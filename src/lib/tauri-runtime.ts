export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

export function isAndroidRuntime(): boolean {
  return (
    isTauriRuntime() &&
    (hasAndroidUserAgent() || hasAndroidStorageBridge())
  );
}

function hasAndroidUserAgent(): boolean {
  return (
    typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent)
  );
}

function hasAndroidStorageBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    "__NoreaAndroidStorage" in
      (window as Window & { __NoreaAndroidStorage?: unknown })
  );
}

export function isWindowsRuntime(): boolean {
  return (
    isTauriRuntime() &&
    typeof navigator !== "undefined" &&
    /\bWindows\b/i.test(navigator.userAgent)
  );
}
