export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

export function isAndroidRuntime(): boolean {
  return (
    isTauriRuntime() &&
    (hasAndroidUserAgent() || hasAndroidBridge())
  );
}

function hasAndroidUserAgent(): boolean {
  return (
    typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent)
  );
}

function hasAndroidBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    "__NoreaAndroidBridge" in
      (window as Window & { __NoreaAndroidBridge?: unknown })
  );
}

export function isWindowsRuntime(): boolean {
  return (
    isTauriRuntime() &&
    typeof navigator !== "undefined" &&
    /\bWindows\b/i.test(navigator.userAgent)
  );
}
