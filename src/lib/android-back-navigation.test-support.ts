import { act, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { startAndroidBackNavigationBridge } from "./android-back-navigation";
import { PageActivityContext } from "./page-activity";

export interface BackNavigationHarness {
  render: (node: ReactNode, options?: { active?: boolean }) => Promise<void>;
  run: (callback: () => void) => Promise<void>;
  pressBack: () => boolean | undefined;
  unmount: () => Promise<void>;
}

/**
 * Mounts a React root without a DOM and starts the Android back bridge, so
 * tests can render hook probes and press the hardware back button.
 */
export function mountBackNavigationHarness(): BackNavigationHarness {
  const document = {
    nodeType: 9, activeElement: null, body: null as unknown,
    documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [],
  };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(container as unknown as Element);
  const stopBridge = startAndroidBackNavigationBridge();

  return {
    render: async (node, options) => {
      await act(async () => root.render(createElement(
        PageActivityContext.Provider,
        { value: options?.active ?? true },
        node,
      )));
    },
    run: async (callback) => {
      await act(async () => callback());
    },
    pressBack: () => {
      let handled: boolean | undefined;
      act(() => { handled = window.__NoreaAndroidBackNavigation?.handle(); });
      return handled;
    },
    unmount: async () => {
      await act(async () => root.unmount());
      stopBridge();
      vi.unstubAllGlobals();
    },
  };
}

/** Element slots of `PageFrame` and `PageHeader` that hold page controls besides `children`. */
export const PAGE_SLOT_PROPS = ["header", "actions", "title", "below"] as const;

/** Flattens a rendered element tree so tests can find elements by props. */
export function collectElements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(collectElements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [
    node,
    ...PAGE_SLOT_PROPS.flatMap((slot) => collectElements(node.props[slot] as ReactNode)),
    ...collectElements(node.props.children as ReactNode),
  ];
}
