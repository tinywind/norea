import { openUrl } from "@tauri-apps/plugin-opener";

const EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Returns the chapter link a reader click landed on, if any. */
export function getReaderLinkElement(
  target: EventTarget | null,
): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLAnchorElement>("a[href]");
}

/**
 * Opens a chapter link outside the app. Links that resolve inside the app
 * origin are ignored so chapter HTML cannot navigate the app window.
 */
export function openReaderLink(link: HTMLAnchorElement): void {
  let url: URL;
  try {
    url = new URL(link.getAttribute("href") ?? "", window.location.href);
  } catch {
    return;
  }
  if (!EXTERNAL_LINK_PROTOCOLS.has(url.protocol)) return;
  if (url.origin === window.location.origin) return;
  void openUrl(url.href).catch((error: unknown) => {
    console.warn("[reader] failed to open chapter link", error);
  });
}
