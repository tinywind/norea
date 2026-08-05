import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Group, Loader, Text } from "@mantine/core";
import { listen } from "@tauri-apps/api/event";
import { CloseGlyph } from "./ActionGlyphs";
import { IconButton } from "./IconButton";
import { useTranslation } from "../i18n";
import {
  getSiteBrowserPlatform,
  type SiteBrowserPlatformApi,
} from "../lib/site-browser";
import { registerPageBackNavigationHandler } from "../lib/android-back-navigation";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { taskScheduler } from "../lib/tasks/scheduler";
import { useSiteBrowserStore } from "../store/site-browser";

const CHROME_HEIGHT = 40;
const BOUNDS_RESYNC_DELAYS_MS = [100, 500, 1000, 2000] as const;
const SCRAPER_CONTROL_POLL_INTERVAL_MS = 250;
const SITE_BROWSER_HIDDEN_EVENT = "site-browser-hidden";
const SITE_BROWSER_HIDDEN_DOM_EVENT = "norea-site-browser-hidden";

function reportScraperError(action: string, error: unknown): void {
  console.error(`[site-browser] ${action} failed`, error);
}

function debugSiteBrowser(message: string, data?: unknown): void {
  console.debug(`[site-browser] ${message}`, data);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function syncSiteBrowserBounds(
  platform: SiteBrowserPlatformApi,
  node: HTMLDivElement | null,
  url: string | null,
): Promise<void> {
  debugSiteBrowser("sync bounds requested", {
    platform: platform.name,
    hasNode: node !== null,
    url,
  });
  const bounds = platform.boundsFor(node);
  if (!bounds) return Promise.resolve();
  return platform.setBounds(bounds, url);
}

/**
 * Full-screen browser host for the persistent scraper Webview. Platform-
 * specific bounds, navigation, and chrome behavior are isolated behind
 * the site-browser platform API.
 *
 * Explicit site opens may recreate the foreground WebView to clear
 * per-WebView navigation history. Browser profile storage survives
 * that reset so a manual login or CF clearance carries over to the
 * next plugin scrape.
 *
 * Android uses a native WebView attached to the main Activity, but it
 * follows the same visible-overlay contract.
 */
export function SiteBrowserOverlay() {
  const { t } = useTranslation();
  const platform = getSiteBrowserPlatform();
  const visible = useSiteBrowserStore((s) => s.visible);
  const currentUrl = useSiteBrowserStore((s) => s.currentUrl);
  const browserTaskId = useSiteBrowserStore((s) => s.taskId);
  const phase = useSiteBrowserStore((s) => s.phase);
  const openSequence = useSiteBrowserStore((s) => s.openSequence);
  const hide = useSiteBrowserStore((s) => s.hide);
  const markReady = useSiteBrowserStore((s) => s.markReady);
  const inPageControls = platform.chromeMode === "in-page";
  const deferDesktopBounds =
    platform.name === "windows" || platform.name === "linux";
  const [loading, setLoading] = useState(false);

  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const lastOpenSequence = useRef<number | null>(null);
  const navigationController = useRef<AbortController | null>(null);
  const nativeHiddenRef = useRef(false);
  const boundsResyncTimers = useRef<number[]>([]);

  const clearBoundsResyncTimers = () => {
    for (const timer of boundsResyncTimers.current) window.clearTimeout(timer);
    boundsResyncTimers.current = [];
  };

  const queueBoundsResync = () => {
    clearBoundsResyncTimers();
    debugSiteBrowser("queue bounds resync", {
      platform: platform.name,
      delays: BOUNDS_RESYNC_DELAYS_MS,
    });
    for (const delay of BOUNDS_RESYNC_DELAYS_MS) {
      const timer = window.setTimeout(() => {
        const node = placeholderRef.current;
        const state = useSiteBrowserStore.getState();
        if (!state.visible) return;
        void syncSiteBrowserBounds(platform, node, state.currentUrl).catch(
          (error) => reportScraperError("set bounds", error),
        );
      }, delay);
      boundsResyncTimers.current.push(timer);
    }
  };

  const closeBrowser = useCallback((): boolean => {
    const state = useSiteBrowserStore.getState();
    if (!state.visible) return false;
    navigationController.current?.abort();
    navigationController.current = null;
    setLoading(false);
    if (state.phase !== "ready" && state.taskId) {
      taskScheduler.cancel(state.taskId);
    }
    hide();
    return true;
  }, [hide]);

  useEffect(() => {
    if (!visible) return;
    return registerPageBackNavigationHandler({ back: closeBrowser });
  }, [closeBrowser, visible]);

  useEffect(() => {
    if (!visible) {
      navigationController.current?.abort();
      navigationController.current = null;
      setLoading(false);
      clearBoundsResyncTimers();
      lastOpenSequence.current = null;
      if (nativeHiddenRef.current) {
        nativeHiddenRef.current = false;
        debugSiteBrowser("hide already handled by native", {
          platform: platform.name,
        });
        return;
      }
      debugSiteBrowser("hide requested", { platform: platform.name });
      void platform.hide().catch((error) => reportScraperError("hide", error));
      return;
    }
    nativeHiddenRef.current = false;
    if (phase !== "loading") return;
    if (currentUrl && openSequence !== lastOpenSequence.current) {
      debugSiteBrowser("open requested", {
        platform: platform.name,
        chromeMode: platform.chromeMode,
        currentUrl,
        openSequence,
        hasPlaceholder: placeholderRef.current !== null,
      });
      lastOpenSequence.current = openSequence;
      navigationController.current?.abort();
      const controller = new AbortController();
      navigationController.current = controller;
      setLoading(true);
      void (async () => {
        try {
          await platform.navigate(currentUrl, {
            resetHistory: true,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          const state = useSiteBrowserStore.getState();
          if (
            !state.visible ||
            state.currentUrl !== currentUrl ||
            state.openSequence !== openSequence ||
            state.phase !== "loading" ||
            state.taskId !== browserTaskId
          ) {
            return;
          }
          const nextNode = placeholderRef.current;
          debugSiteBrowser("navigate returned", {
            platform: platform.name,
            currentUrl,
            openSequence,
            hasPlaceholder: nextNode !== null,
          });
          if (!deferDesktopBounds && (inPageControls || nextNode)) {
            await syncSiteBrowserBounds(platform, nextNode, currentUrl);
          }
          if (!deferDesktopBounds) queueBoundsResync();
          if (browserTaskId) markReady(browserTaskId);
          if (navigationController.current === controller) {
            navigationController.current = null;
            setLoading(false);
          }
        } catch (error) {
          if (navigationController.current === controller) {
            navigationController.current = null;
            lastOpenSequence.current = null;
            setLoading(false);
          }
          if (!isAbortError(error)) {
            reportScraperError("navigate", error);
            if (browserTaskId) taskScheduler.cancel(browserTaskId);
            useSiteBrowserStore.getState().hide();
          }
        }
      })();
    }
  }, [
    browserTaskId,
    currentUrl,
    deferDesktopBounds,
    inPageControls,
    markReady,
    openSequence,
    phase,
    platform,
    visible,
  ]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const handleNativeHidden = () => {
      if (!useSiteBrowserStore.getState().visible) {
        nativeHiddenRef.current = false;
        return;
      }
      nativeHiddenRef.current = true;
      debugSiteBrowser("native hidden event received", {
        platform: platform.name,
      });
      useSiteBrowserStore.getState().hide();
    };
    window.addEventListener(SITE_BROWSER_HIDDEN_DOM_EVENT, handleNativeHidden);
    void listen(SITE_BROWSER_HIDDEN_EVENT, handleNativeHidden)
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((error) => reportScraperError("listen hidden event", error));
    return () => {
      disposed = true;
      window.removeEventListener(
        SITE_BROWSER_HIDDEN_DOM_EVENT,
        handleNativeHidden,
      );
      unlisten?.();
    };
  }, [platform.name]);

  useEffect(() => {
    if (!visible || !inPageControls || phase !== "ready") return;
    let disposed = false;
    const poll = () => {
      void platform
        .pollControlMessage()
        .then((message) => {
          if (disposed || message?.action !== "close") return;
          closeBrowser();
        })
        .catch((error) => reportScraperError("poll controls", error));
    };
    poll();
    const timer = window.setInterval(poll, SCRAPER_CONTROL_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [closeBrowser, currentUrl, inPageControls, phase, platform, visible]);

  useEffect(() => {
    if (!visible) return;
    if (deferDesktopBounds && (phase !== "ready" || loading)) return;
    if (inPageControls) {
      const sendBounds = () => {
        void syncSiteBrowserBounds(platform, null, currentUrl).catch((error) =>
          reportScraperError("set bounds", error),
        );
        queueBoundsResync();
      };
      sendBounds();
      window.addEventListener("resize", sendBounds);
      window.visualViewport?.addEventListener("resize", sendBounds);
      return () => {
        window.removeEventListener("resize", sendBounds);
        window.visualViewport?.removeEventListener("resize", sendBounds);
      };
    }
    const node = placeholderRef.current;
    if (!node) return;

    const sendBounds = () => {
      void syncSiteBrowserBounds(platform, node, currentUrl).catch((error) =>
        reportScraperError("set bounds", error),
      );
    };

    sendBounds();
    if (deferDesktopBounds) queueBoundsResync();
    const observer = new ResizeObserver(sendBounds);
    observer.observe(node);
    window.addEventListener("resize", sendBounds);
    window.visualViewport?.addEventListener("resize", sendBounds);
    window.visualViewport?.addEventListener("scroll", sendBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sendBounds);
      window.visualViewport?.removeEventListener("resize", sendBounds);
      window.visualViewport?.removeEventListener("scroll", sendBounds);
    };
  }, [
    currentUrl,
    deferDesktopBounds,
    inPageControls,
    loading,
    phase,
    platform,
    visible,
  ]);

  if (!visible) return null;
  const browserLoading = phase !== "ready" || loading;
  if (inPageControls) {
    debugSiteBrowser("react overlay skipped for in-page chrome", {
      platform: platform.name,
      currentUrl,
      openSequence,
    });
    if (!browserLoading) return null;
    return (
      <Box
        aria-busy="true"
        role="dialog"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          backgroundColor: "var(--mantine-color-body)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <Group gap="sm">
          <Loader size="sm" />
          <Text>{t("common.loading")}</Text>
          <IconButton
            label={t("siteBrowser.close")}
            size="lg"
            onClick={closeBrowser}
          >
            <CloseGlyph />
          </IconButton>
        </Group>
      </Box>
    );
  }

  return (
    <Box
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        backgroundColor: "var(--mantine-color-body)",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        paddingTop: "var(--lnr-safe-area-top)",
        paddingRight: "var(--lnr-safe-area-right)",
        paddingBottom: "var(--lnr-safe-area-bottom)",
        paddingLeft: "var(--lnr-safe-area-left)",
      }}
    >
      <Group
        h={CHROME_HEIGHT}
        px="md"
        justify="space-between"
        style={{
          borderBottom: "1px solid var(--mantine-color-default-border)",
          backgroundColor: "var(--mantine-color-body)",
          flexShrink: 0,
          position: "relative",
          zIndex: 1,
        }}
      >
        <Text size="sm" c="dimmed" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
          {currentUrl ?? ""}
        </Text>
        <IconButton
          label={t("siteBrowser.close")}
          size="lg"
          onClick={closeBrowser}
        >
          <CloseGlyph />
        </IconButton>
      </Group>
      <div
        ref={placeholderRef}
        style={{ flex: 1, minHeight: 0, position: "relative" }}
      >
        {browserLoading ? (
          <Box
            aria-busy="true"
            role="status"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 1,
              backgroundColor: "var(--mantine-color-body)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Group gap="sm">
              <Loader size="sm" />
              <Text>{t("common.loading")}</Text>
            </Group>
          </Box>
        ) : null}
      </div>
    </Box>
  );
}
