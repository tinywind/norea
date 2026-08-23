import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Group, Loader, Text } from "@mantine/core";
import { CloseGlyph } from "./ActionGlyphs";
import { IconButton } from "./IconButton";
import { useTranslation } from "../i18n";
import {
  getSiteBrowserPlatform,
  type SiteBrowserPlatformApi,
} from "../lib/site-browser";
import { registerPageBackNavigationHandler } from "../lib/android-back-navigation";
import { sourceAccessScopeKey } from "../lib/plugins/source-access";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { taskScheduler } from "../lib/tasks/scheduler";
import { redactUrlForLog, redactUrlsForLog } from "../lib/url-log";
import { useSiteBrowserStore } from "../store/site-browser";

const CHROME_HEIGHT = 40;
const BOUNDS_RESYNC_DELAYS_MS = [100, 500, 1000, 2000] as const;
const SCRAPER_ORIGIN_POLL_INTERVAL_MS = 500;
const SITE_BROWSER_HIDDEN_DOM_EVENT = "norea-site-browser-hidden";

function reportScraperError(action: string, error: unknown): void {
  console.error(
    `[site-browser] ${action} failed`,
    redactUrlsForLog(error instanceof Error ? error.message : String(error)),
  );
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

function sourceAccessOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

interface SourceAccessOriginObservation {
  openSequence: number;
  origin: string;
  revision: number;
  taskId: string;
}

function syncSiteBrowserBounds(
  platform: SiteBrowserPlatformApi,
  node: HTMLDivElement | null,
  url: string | null,
): Promise<void> {
  debugSiteBrowser("sync bounds requested", {
    platform: platform.name,
    hasNode: node !== null,
    url: url ? redactUrlForLog(url) : null,
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
  const context = useSiteBrowserStore((s) => s.context);
  const hide = useSiteBrowserStore((s) => s.hide);
  const markReady = useSiteBrowserStore((s) => s.markReady);
  const sourceAccessContext = context?.mode === "source-access" ? context : null;
  const sourceAccessTitle = sourceAccessContext
    ? sourceAccessContext.challenge.kind === "captcha"
      ? t("sourceAccess.captchaTitle")
      : t("sourceAccess.cloudflareTitle")
    : null;
  const keepPausedLabel = t("sourceAccess.keepPaused");
  const verifyLabel = t("sourceAccess.verifyAndResume");
  const inPageControls = platform.chromeMode === "in-page";
  const deferDesktopBounds =
    platform.name === "windows" || platform.name === "linux";
  const [loading, setLoading] = useState(false);
  const [originObservation, setOriginObservation] =
    useState<SourceAccessOriginObservation | null>(null);

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

  const finishSourceAccess = useCallback(
    (
      expectedTaskId: string | null,
      expectedRevision: number,
      expectedOpenSequence: number,
      outcome: "keep-paused" | "verify",
    ): boolean => {
      const state = useSiteBrowserStore.getState();
      if (
        !state.visible ||
        !expectedTaskId ||
        state.taskId !== expectedTaskId ||
        state.openSequence !== expectedOpenSequence ||
        state.context?.mode !== "source-access" ||
        state.context.revision !== expectedRevision ||
        (outcome === "verify" && state.phase !== "ready")
      ) {
        return false;
      }
      if (!state.complete(expectedTaskId, expectedRevision, outcome)) {
        return false;
      }
      navigationController.current?.abort();
      navigationController.current = null;
      setLoading(false);
      setOriginObservation(null);
      return true;
    },
    [],
  );

  const verifySourceAccess = useCallback(
    async (
      expectedTaskId: string | null,
      expectedRevision: number,
      expectedOpenSequence: number,
      expectedScopeKey: string,
    ): Promise<boolean> => {
      let origin: string | null = null;
      try {
        origin = sourceAccessOrigin(await platform.currentOrigin());
      } catch (error) {
        reportScraperError("read current origin", error);
      }
      const state = useSiteBrowserStore.getState();
      if (
        !state.visible ||
        !expectedTaskId ||
        state.phase !== "ready" ||
        state.taskId !== expectedTaskId ||
        state.openSequence !== expectedOpenSequence ||
        state.context?.mode !== "source-access" ||
        state.context.scopeKey !== expectedScopeKey ||
        state.context.revision !== expectedRevision
      ) {
        return false;
      }
      if (!origin || sourceAccessScopeKey(origin) !== expectedScopeKey) {
        setOriginObservation(null);
        return false;
      }
      setOriginObservation({
        openSequence: expectedOpenSequence,
        origin,
        revision: expectedRevision,
        taskId: expectedTaskId,
      });
      const currentBlock = taskScheduler
        .getSnapshot()
        .sourceAccessBlocks.find(
          (block) =>
            block.scopeKey === expectedScopeKey &&
            block.revision === expectedRevision,
        );
      if (
        !currentBlock ||
        !taskScheduler.beginSourceAccessVerification(expectedScopeKey)
      ) {
        return false;
      }
      const finished = finishSourceAccess(
        expectedTaskId,
        expectedRevision,
        expectedOpenSequence,
        "verify",
      );
      if (!finished) taskScheduler.keepSourceAccessBlocked(expectedScopeKey);
      return finished;
    },
    [finishSourceAccess, platform],
  );

  const closeBrowser = useCallback((): boolean => {
    const state = useSiteBrowserStore.getState();
    if (!state.visible) return false;
    if (state.context?.mode === "source-access") {
      return finishSourceAccess(
        state.taskId,
        state.context.revision,
        state.openSequence,
        "keep-paused",
      );
    }
    navigationController.current?.abort();
    navigationController.current = null;
    setLoading(false);
    if (state.phase !== "ready" && state.taskId) {
      taskScheduler.cancel(state.taskId);
    }
    hide();
    return true;
  }, [finishSourceAccess, hide]);

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
        currentUrl: redactUrlForLog(currentUrl),
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
            currentUrl: redactUrlForLog(currentUrl),
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
          const ownsNavigation = navigationController.current === controller;
          if (ownsNavigation) {
            navigationController.current = null;
            lastOpenSequence.current = null;
            setLoading(false);
          }
          if (!isAbortError(error)) {
            reportScraperError("navigate", error);
            const state = useSiteBrowserStore.getState();
            if (
              ownsNavigation &&
              state.visible &&
              state.currentUrl === currentUrl &&
              state.openSequence === openSequence &&
              state.phase === "loading" &&
              state.taskId === browserTaskId
            ) {
              if (browserTaskId) taskScheduler.cancel(browserTaskId);
              state.hide();
            }
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
    const handleNativeHidden = () => {
      if (!useSiteBrowserStore.getState().visible) {
        nativeHiddenRef.current = false;
        return;
      }
      nativeHiddenRef.current = true;
      debugSiteBrowser("native hidden event received", {
        platform: platform.name,
      });
      closeBrowser();
    };
    window.addEventListener(SITE_BROWSER_HIDDEN_DOM_EVENT, handleNativeHidden);
    return () => {
      window.removeEventListener(
        SITE_BROWSER_HIDDEN_DOM_EVENT,
        handleNativeHidden,
      );
    };
  }, [closeBrowser, platform.name]);

  useEffect(() => {
    setOriginObservation(null);
    if (
      !visible ||
      phase !== "ready" ||
      !browserTaskId ||
      !sourceAccessContext
    ) {
      return;
    }

    let disposed = false;
    const poll = () => {
      void platform
        .currentOrigin()
        .then((origin) => {
          const state = useSiteBrowserStore.getState();
          if (
            disposed ||
            !state.visible ||
            state.phase !== "ready" ||
            state.taskId !== browserTaskId ||
            state.openSequence !== openSequence ||
            state.context?.mode !== "source-access" ||
            state.context.scopeKey !== sourceAccessContext.scopeKey ||
            state.context.revision !== sourceAccessContext.revision
          ) {
            return;
          }
          const normalizedOrigin = sourceAccessOrigin(origin);
          setOriginObservation(
            normalizedOrigin
              ? {
                  openSequence,
                  origin: normalizedOrigin,
                  revision: sourceAccessContext.revision,
                  taskId: browserTaskId,
                }
              : null,
          );
        })
        .catch((error) => {
          if (!disposed) setOriginObservation(null);
          reportScraperError("read current origin", error);
        });
    };
    poll();
    const timer = window.setInterval(poll, SCRAPER_ORIGIN_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    browserTaskId,
    openSequence,
    phase,
    platform,
    sourceAccessContext,
    visible,
  ]);

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
  const displayedOrigin =
    originObservation &&
    originObservation.taskId === browserTaskId &&
    originObservation.openSequence === openSequence &&
    originObservation.revision === sourceAccessContext?.revision
      ? originObservation.origin
      : null;
  const expectedOrigin = sourceAccessContext
    ? sourceAccessOrigin(sourceAccessContext.challenge.url)
    : null;
  const displayedOriginLabel = browserLoading
    ? (expectedOrigin ?? "")
    : (displayedOrigin ?? t("sourceAccess.originUnavailable"));
  const canVerifySourceAccess =
    !browserLoading &&
    displayedOrigin !== null &&
    sourceAccessContext !== null &&
    sourceAccessScopeKey(displayedOrigin) === sourceAccessContext.scopeKey;
  if (inPageControls) {
    debugSiteBrowser("react overlay skipped for in-page chrome", {
      platform: platform.name,
      currentUrl: currentUrl ? redactUrlForLog(currentUrl) : null,
      openSequence,
    });
    if (!browserLoading) return null;
    return (
      <Box
        aria-busy="true"
        aria-labelledby="norea-site-browser-loading-title"
        aria-modal="true"
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
          <Text id="norea-site-browser-loading-title">
            {sourceAccessTitle ?? t("common.loading")}
          </Text>
          <IconButton
            label={
              sourceAccessContext ? keepPausedLabel : t("siteBrowser.close")
            }
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
      aria-describedby={
        sourceAccessContext ? "norea-site-browser-instructions" : undefined
      }
      aria-labelledby="norea-site-browser-title"
      aria-modal="true"
      role="dialog"
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
        {sourceAccessContext ? (
          <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <Text id="norea-site-browser-title" size="sm" fw={600}>
              {sourceAccessTitle}
            </Text>
            <Text size="sm" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
              {displayedOriginLabel}
            </Text>
          </Group>
        ) : (
          <Text
            id="norea-site-browser-title"
            size="sm"
            c="dimmed"
            lineClamp={1}
            style={{ flex: 1, minWidth: 0 }}
          >
            {currentUrl ?? ""}
          </Text>
        )}
        <IconButton
          label={
            sourceAccessContext ? keepPausedLabel : t("siteBrowser.close")
          }
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
      {sourceAccessContext ? (
        <Box
          id="norea-site-browser-instructions"
          px="md"
          py="sm"
          style={{
            borderTop: "1px solid var(--mantine-color-default-border)",
            backgroundColor: "var(--mantine-color-body)",
            flexShrink: 0,
          }}
        >
          <Group justify="space-between" align="center" wrap="wrap" gap="sm">
            <Text size="sm">
              {t("sourceAccess.browserInstructions", {
                source: sourceAccessContext.sourceName,
              })}
            </Text>
            <Group gap="xs">
              <Button
                variant="default"
                onClick={() =>
                  finishSourceAccess(
                    browserTaskId,
                    sourceAccessContext.revision,
                    openSequence,
                    "keep-paused",
                  )
                }
              >
                {keepPausedLabel}
              </Button>
              <Button
                disabled={!canVerifySourceAccess}
                onClick={() =>
                  void verifySourceAccess(
                    browserTaskId,
                    sourceAccessContext.revision,
                    openSequence,
                    sourceAccessContext.scopeKey,
                  )
                }
              >
                {verifyLabel}
              </Button>
            </Group>
          </Group>
        </Box>
      ) : null}
    </Box>
  );
}
