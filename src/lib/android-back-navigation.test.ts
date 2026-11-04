import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPageBackNavigationHandler,
  startAndroidBackNavigationBridge,
  useOverlayBackNavigation,
  usePageBackNavigation,
} from "./android-back-navigation";
import { mountBackNavigationHarness, type BackNavigationHarness } from "./android-back-navigation.test-support";

const cleanups: Array<() => void> = [];
let harness: BackNavigationHarness | undefined;

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  harness = mountBackNavigationHarness();
}

interface OverlayProbeProps {
  opened: boolean;
  onClose: () => void;
}

function OverlayProbe({ opened, onClose }: OverlayProbeProps) {
  useOverlayBackNavigation(opened, onClose);
  return null;
}

interface PageProbeProps {
  active?: boolean;
  overlays: OverlayProbeProps[];
  pageBack: () => boolean;
}

function PageContent({ overlays, pageBack }: PageProbeProps) {
  usePageBackNavigation(pageBack);
  return overlays.map((overlay, index) => createElement(OverlayProbe, { key: index, ...overlay }));
}

async function renderPage(props: PageProbeProps) {
  await harness!.render(createElement(PageContent, props), { active: props.active });
}

const pressBack = () => harness!.pressBack();

describe("Android back navigation", () => {
  it("leaves back navigation unhandled when the page has no explicit handler", () => {
    vi.stubGlobal("window", {});
    cleanups.push(startAndroidBackNavigationBridge());

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(false);
  });

  it("uses the most recently registered page back handler", () => {
    vi.stubGlobal("window", {});
    const firstBack = vi.fn(() => true);
    const secondBack = vi.fn(() => true);
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(
      registerPageBackNavigationHandler({ back: firstBack }),
      registerPageBackNavigationHandler({ back: secondBack }),
    );

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(secondBack).toHaveBeenCalledTimes(1);
    expect(firstBack).not.toHaveBeenCalled();

    cleanups.pop()?.();

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(firstBack).toHaveBeenCalledTimes(1);
  });

  it("falls through when a newer handler performs no action", () => {
    vi.stubGlobal("window", {});
    const pageBack = vi.fn(() => true);
    const staleBack = vi.fn(() => false);
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(
      registerPageBackNavigationHandler({ back: pageBack }),
      registerPageBackNavigationHandler({ back: staleBack }),
    );

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(staleBack).toHaveBeenCalledTimes(1);
    expect(pageBack).toHaveBeenCalledTimes(1);
  });

  it("falls through after a transient handler finishes its work", () => {
    vi.stubGlobal("window", {});
    const pageBack = vi.fn(() => true);
    const transientBack = vi.fn(() => false).mockReturnValueOnce(true);
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(
      registerPageBackNavigationHandler({ back: pageBack }),
      registerPageBackNavigationHandler({ back: transientBack }),
    );

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(pageBack).not.toHaveBeenCalled();

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(pageBack).toHaveBeenCalledTimes(1);
  });

  it("leaves back navigation unhandled when no handler performs an action", () => {
    vi.stubGlobal("window", {});
    const noActionBack = vi.fn(() => false);
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(
      registerPageBackNavigationHandler({ back: noActionBack }),
    );

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(false);
    expect(noActionBack).toHaveBeenCalledTimes(1);
  });

  it("closes an open menu or select dropdown before any handler", () => {
    const dispatched: string[] = [];
    const dropdown = (visible: boolean, name: string) => ({
      getClientRects: () => (visible ? [{}] : []),
      dispatchEvent: (event: { key: string }) => {
        dispatched.push(`${name}:${event.key}`);
        return true;
      },
    });
    let open = [dropdown(false, "hidden"), dropdown(true, "menu"), dropdown(true, "listbox")];
    const querySelectorAll = vi.fn(() => open);
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { querySelectorAll });
    vi.stubGlobal("KeyboardEvent", class { constructor(_type: string, readonly init: { key: string }) {} get key() { return this.init.key; } });
    const pageBack = vi.fn(() => true);
    cleanups.push(startAndroidBackNavigationBridge());
    cleanups.push(registerPageBackNavigationHandler({ back: pageBack }));

    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(querySelectorAll).toHaveBeenCalledWith('[role="menu"], [role="listbox"]');
    expect(dispatched).toEqual(["listbox:Escape"]);
    expect(pageBack).not.toHaveBeenCalled();

    open = [dropdown(false, "hidden")];
    expect(window.__NoreaAndroidBackNavigation?.handle()).toBe(true);
    expect(dispatched).toEqual(["listbox:Escape"]);
    expect(pageBack).toHaveBeenCalledTimes(1);
  });

  it("closes a child overlay before the page handler that registered after the child mounted", async () => {
    mount();
    const pageBack = vi.fn(() => true);
    const close = vi.fn();
    await renderPage({ pageBack, overlays: [{ opened: false, onClose: close }] });

    expect(pressBack()).toBe(true);
    expect(pageBack).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    await renderPage({ pageBack, overlays: [{ opened: true, onClose: close }] });
    expect(pressBack()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(pageBack).toHaveBeenCalledTimes(1);

    await renderPage({ pageBack, overlays: [{ opened: false, onClose: close }] });
    expect(pressBack()).toBe(true);
    expect(pageBack).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the most recently opened overlay first", async () => {
    mount();
    const pageBack = vi.fn(() => true);
    const closeDrawer = vi.fn();
    const closeConfirmation = vi.fn();
    await renderPage({ pageBack, overlays: [{ opened: true, onClose: closeDrawer }, { opened: false, onClose: closeConfirmation }] });
    await renderPage({ pageBack, overlays: [{ opened: true, onClose: closeDrawer }, { opened: true, onClose: closeConfirmation }] });

    pressBack();
    expect(closeConfirmation).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();

    await renderPage({ pageBack, overlays: [{ opened: true, onClose: closeDrawer }, { opened: false, onClose: closeConfirmation }] });
    pressBack();
    expect(closeDrawer).toHaveBeenCalledTimes(1);
    expect(pageBack).not.toHaveBeenCalled();
  });

  it("consumes back while an open overlay ignores the close request", async () => {
    mount();
    const pageBack = vi.fn(() => true);
    const busyClose = vi.fn();
    await renderPage({ pageBack, overlays: [{ opened: false, onClose: busyClose }] });
    await renderPage({ pageBack, overlays: [{ opened: true, onClose: busyClose }] });

    expect(pressBack()).toBe(true);
    expect(pressBack()).toBe(true);
    expect(busyClose).toHaveBeenCalledTimes(2);
    expect(pageBack).not.toHaveBeenCalled();
  });

  it("does not register overlays of a hidden page slot", async () => {
    mount();
    const pageBack = vi.fn(() => true);
    const close = vi.fn();
    await renderPage({ active: false, pageBack, overlays: [{ opened: true, onClose: close }] });

    expect(pressBack()).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(pageBack).not.toHaveBeenCalled();
  });

  it("keeps an open overlay above the page handler when the page slot becomes active again", async () => {
    mount();
    const pageBack = vi.fn(() => true);
    const close = vi.fn();
    await renderPage({ pageBack, overlays: [{ opened: true, onClose: close }] });
    await renderPage({ active: false, pageBack, overlays: [{ opened: true, onClose: close }] });
    await renderPage({ active: true, pageBack, overlays: [{ opened: true, onClose: close }] });

    pressBack();
    expect(close).toHaveBeenCalledTimes(1);
    expect(pageBack).not.toHaveBeenCalled();
  });
});
