import { translate } from "../i18n";
import { useAppearanceStore } from "../store/appearance";

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

/** The storage folder is only used with All files access, so choosing one stops without it. */
export class AndroidAllFilesAccessRequiredError extends Error {
  constructor() {
    super(translate(useAppearanceStore.getState().appLocale, "settings.data.mediaStorage.allFiles.required"));
    this.name = "AndroidAllFilesAccessRequiredError";
  }
}

/**
 * Resolves true when Norea may use the storage folder: All files access is granted, or the
 * device predates it. Otherwise opens the permission screen and resolves with the answer once
 * the user returns to Norea.
 */
export async function ensureAndroidAllFilesAccess(): Promise<boolean> {
  const granted = androidAllFilesAccessGranted();
  if (granted !== false) return true;
  if (!requestAndroidAllFilesAccess()) return false;
  await new Promise<void>((resolve) => window.addEventListener("norea-app-resumed", () => resolve(), { once: true }));
  return androidAllFilesAccessGranted() === true;
}
