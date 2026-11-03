import { useEffect, useLayoutEffect, useRef } from "react";
import { usePageActivity } from "./page-activity";

export interface PageBackNavigationHandler {
  back: () => boolean;
}

export interface AndroidBackNavigationBridge {
  handle: () => boolean;
}

declare global {
  interface Window {
    __NoreaAndroidBackNavigation?: AndroidBackNavigationBridge;
  }
}

const handlers: PageBackNavigationHandler[] = [];

export function registerPageBackNavigationHandler(
  handler: PageBackNavigationHandler,
): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

export function startAndroidBackNavigationBridge(): () => void {
  if (typeof window === "undefined") return () => undefined;

  const bridge: AndroidBackNavigationBridge = {
    handle: () => {
      for (let index = handlers.length - 1; index >= 0; index -= 1) {
        if (handlers[index]?.back()) return true;
      }
      return false;
    },
  };
  window.__NoreaAndroidBackNavigation = bridge;

  return () => {
    if (window.__NoreaAndroidBackNavigation === bridge) {
      delete window.__NoreaAndroidBackNavigation;
    }
  };
}

export function usePageBackNavigation(onBack: () => boolean): void {
  const active = usePageActivity();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // Layout effects run before passive effects in the same commit, so a page
  // registers below any overlay that is already open when it mounts or
  // becomes active again.
  useLayoutEffect(() => {
    if (!active) return;
    return registerPageBackNavigationHandler({
      back: () => onBackRef.current(),
    });
  }, [active]);
}

/**
 * Closes an overlay on Android back while it is open. The handler registers
 * only while `opened` is true and after the page handler, so it consumes back
 * before the page can navigate.
 */
export function useOverlayBackNavigation(
  opened: boolean,
  onClose: () => void,
): void {
  const active = usePageActivity();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active || !opened) return;
    return registerPageBackNavigationHandler({
      back: () => {
        onCloseRef.current();
        return true;
      },
    });
  }, [active, opened]);
}
