interface AndroidAllFilesAccessBridge {
  isSupported: () => boolean;
  isGranted: () => boolean;
  request: () => boolean;
}

declare global {
  interface Window {
    __NoreaAndroidAllFilesAccess?: AndroidAllFilesAccessBridge;
  }
}

function bridge(): AndroidAllFilesAccessBridge | undefined {
  return typeof window === "undefined" ? undefined : window.__NoreaAndroidAllFilesAccess;
}

/** Whether Norea has All files access; null outside the Android host or before Android 11. */
export function androidAllFilesAccessGranted(): boolean | null {
  const current = bridge();
  return current?.isSupported() ? current.isGranted() : null;
}

/** Opens Android's All files access screen; false when no such screen could open. */
export function requestAndroidAllFilesAccess(): boolean {
  return bridge()?.request() ?? false;
}
