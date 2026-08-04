import { useEffect, useRef } from "react";

export interface PageBackNavigationHandler {
  back: () => void;
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
      const handler = handlers.at(-1);
      if (!handler) return false;
      handler.back();
      return true;
    },
  };
  window.__NoreaAndroidBackNavigation = bridge;

  return () => {
    if (window.__NoreaAndroidBackNavigation === bridge) {
      delete window.__NoreaAndroidBackNavigation;
    }
  };
}

export function usePageBackNavigation(onBack: () => void): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(
    () =>
      registerPageBackNavigationHandler({
        back: () => onBackRef.current(),
      }),
    [],
  );
}
