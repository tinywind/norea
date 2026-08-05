import { useEffect, useRef } from "react";

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
