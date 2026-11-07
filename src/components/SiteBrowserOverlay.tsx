import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Loader, Text } from "@mantine/core";
import { PageHeader } from "./AppFrame";
import { SiteBrowserAddressBar } from "./SiteBrowserAddressBar";
import { useTranslation } from "../i18n";
import {
  getSiteBrowserPlatform,
  type SiteBrowserPlatformApi,
} from "../lib/site-browser";
import { registerPageBackNavigationHandler } from "../lib/android-back-navigation";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { sourceAccessChallengeTitleKey } from "../lib/plugins/source-access";
import { isAbortError } from "../lib/abort";
import { taskScheduler } from "../lib/tasks/scheduler";
import { cancelSourceAccessWait } from "../lib/tasks/source-access-coordinator";
import { redactUrlForLog, redactUrlsForLog } from "../lib/url-log";
import { useSiteBrowserStore } from "../store/site-browser";
import "../styles/site-browser.css";

const BOUNDS_RESYNC_DELAYS_MS = [100, 500, 1000, 2000] as const;
const SCRAPER_ORIGIN_POLL_INTERVAL_MS = 500;
const SITE_BROWSER_HIDDEN_DOM_EVENT = "norea-site-browser-hidden";

function reportScraperError(action: string, error: unknown): void {
  console.error(
    `[site-browser] ${action} failed`,
    redactUrlsForLog(error instanceof Error ? error.message : String(error)),
  );
}

function siteHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function debugSiteBrowser(message: string, data?: unknown): void {
  console.debug(`[site-browser] ${message}`, data);
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

interface BrowserLocationObservation {
  openSequence: number;
  origin: string;
  revision: number | null;
  sourceId: string;
  taskId: string;
  url: string | null;
}

function syncSiteBrowserBounds(
  platform: SiteBrowserPlatformApi,
  node: HTMLDivElement | null,
  url: string | null,
  sourceId: string | null,
): Promise<void> {
  debugSiteBrowser("sync bounds requested", {
    platform: platform.name,
    hasNode: node !== null,
    url: url ? redactUrlForLog(url) : null,
  });
  const bounds = platform.boundsFor(node);
  if (!bounds) return Promise.resolve();
  return platform.setBounds(bounds, url, sourceId);
}

/**
 * Full-screen browser host for the persistent scraper Webview. Platform-
 * specific bounds and navigation behavior are isolated behind
 * the site-browser platform API.
 *
 * Hiding and reopening the same source reuses its foreground WebView so the
 * browser-owned session remains available to later plugin requests without
 * leaking into another source.
 *
 * Android uses a native WebView attached to the main Activity, but it
 * follows the same visible-overlay contract.
 */
export function SiteBrowserOverlay() {
  const { t } = useTranslation();
  const platform = getSiteBrowserPlatform();
  const visible = useSiteBrowserStore((s) => s.visible);
  const currentUrl = useSiteBrowserStore((s) => s.currentUrl);
  const sourceId = useSiteBrowserStore((s) => s.sourceId);
  const browserTaskId = useSiteBrowserStore((s) => s.taskId);
  const phase = useSiteBrowserStore((s) => s.phase);
  const navigationError = useSiteBrowserStore((s) => s.navigationError);
  const openSequence = useSiteBrowserStore((s) => s.openSequence);
  const context = useSiteBrowserStore((s) => s.context);
  const hide = useSiteBrowserStore((s) => s.hide);
  const markReady = useSiteBrowserStore((s) => s.markReady);
  const sourceAccessContext = context?.mode === "source-access" ? context : null;
  const sourceAccessTitle = sourceAccessContext
    ? t(sourceAccessChallengeTitleKey(sourceAccessContext.challenge.kind))
    : null;
  const keepPausedLabel = t("sourceAccess.keepPaused");
  const verifyLabel = t("sourceAccess.verifyAndResume");
  const deferWindowsBounds = platform.name === "windows";
  const [loading, setLoading] = useState(false);
  const [originObservation, setOriginObservation] =
    useState<BrowserLocationObservation | null>(null);

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
        if (!state.visible || state.phase === "error") return;
        void syncSiteBrowserBounds(
          platform,
          node,
          state.currentUrl,
          state.sourceId,
        ).catch(
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
      expectedSourceId: string,
    ): Promise<boolean> => {
      let origin: string | null = null;
      try {
        origin = sourceAccessOrigin(
          await platform.currentOrigin(expectedSourceId),
        );
      } catch (error) {
        reportScraperError("read current origin", error);
      }
      const state = useSiteBrowserStore.getState();
      if (
        !state.visible ||
        !expectedTaskId ||
        state.phase !== "ready" ||
        state.taskId !== expectedTaskId ||
        state.sourceId !== expectedSourceId ||
        state.openSequence !== expectedOpenSequence ||
        state.context?.mode !== "source-access" ||
        state.context.scopeKey !== expectedScopeKey ||
        state.context.revision !== expectedRevision
      ) {
        return false;
      }
      if (!origin) {
        setOriginObservation(null);
        return false;
      }
      setOriginObservation({
        openSequence: expectedOpenSequence,
        origin,
        revision: expectedRevision,
        sourceId: expectedSourceId,
        taskId: expectedTaskId,
        url: null,
      });
      const currentBlock = taskScheduler
        .getSnapshot()
        .sourceAccessBlocks.find(
          (block) =>
            block.scopeKey === expectedScopeKey &&
            block.revision === expectedRevision,
        );
      // Authentication can redirect to a new hostname. Only retry the original
      // blocked request; its successful source response releases the queue.
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
    if (sourceId && currentUrl && openSequence !== lastOpenSequence.current) {
      debugSiteBrowser("open requested", {
        platform: platform.name,
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
          await platform.navigate(sourceId, currentUrl, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          const state = useSiteBrowserStore.getState();
          if (
            !state.visible ||
            state.sourceId !== sourceId ||
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
          if (!deferWindowsBounds && nextNode) {
            await syncSiteBrowserBounds(
              platform,
              nextNode,
              currentUrl,
              sourceId,
            );
          }
          if (!deferWindowsBounds) queueBoundsResync();
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
              clearBoundsResyncTimers();
              setOriginObservation(null);
              if (browserTaskId) {
                state.markNavigationError(
                  browserTaskId,
                  openSequence,
                  error instanceof Error ? error.message : String(error),
                );
              }
              // Collapse only the native surface, not the task-owned browser.
              // The error screen keeps Retry, address entry, and Close available.
              void platform.hide().catch((hideError) =>
                reportScraperError("hide failed page", hideError),
              );
            }
          }
        }
      })();
    }
  }, [
    browserTaskId,
    currentUrl,
    deferWindowsBounds,
    markReady,
    openSequence,
    phase,
    platform,
    sourceId,
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
      !sourceId
    ) {
      return;
    }

    let disposed = false;
    const poll = () => {
      void platform
        .currentUrl(sourceId)
        .then((url) => {
          const state = useSiteBrowserStore.getState();
          if (
            disposed ||
            !state.visible ||
            state.phase !== "ready" ||
            state.taskId !== browserTaskId ||
            state.sourceId !== sourceId ||
            state.openSequence !== openSequence ||
            (sourceAccessContext &&
              (state.context?.mode !== "source-access" ||
                state.context.scopeKey !== sourceAccessContext.scopeKey ||
                state.context.revision !== sourceAccessContext.revision))
          ) {
            return;
          }
          const normalizedOrigin = sourceAccessOrigin(url);
          setOriginObservation(
            normalizedOrigin
              ? {
                  openSequence,
                  origin: normalizedOrigin,
                  revision: sourceAccessContext?.revision ?? null,
                  sourceId,
                  taskId: browserTaskId,
                  url,
                }
              : null,
          );
        })
        .catch((error) => {
          if (!disposed) setOriginObservation(null);
          reportScraperError("read current address", error);
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
    sourceId,
    sourceAccessContext,
    visible,
  ]);

  useEffect(() => {
    if (!visible) return;
    if (phase === "error") return;
    if (deferWindowsBounds && (phase !== "ready" || loading)) return;
    const node = placeholderRef.current;
    if (!node) return;

    const sendBounds = () => {
      const state = useSiteBrowserStore.getState();
      if (!state.visible || state.phase === "error") return;
      void syncSiteBrowserBounds(platform, node, currentUrl, sourceId).catch(
        (error) => reportScraperError("set bounds", error),
      );
    };

    sendBounds();
    if (deferWindowsBounds) queueBoundsResync();
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
    deferWindowsBounds,
    loading,
    phase,
    platform,
    sourceId,
    visible,
  ]);

  if (!visible) return null;
  const browserLoading = phase === "queued" || phase === "loading" || loading;
  const currentObservation =
    originObservation &&
    originObservation.taskId === browserTaskId &&
    originObservation.sourceId === sourceId &&
    originObservation.openSequence === openSequence &&
    originObservation.revision === (sourceAccessContext?.revision ?? null)
      ? originObservation
      : null;
  const displayedOrigin = currentObservation?.origin ?? null;
  const expectedOrigin = sourceAccessContext
    ? sourceAccessOrigin(sourceAccessContext.challenge.url)
    : null;
  const displayedOriginLabel = browserLoading
    ? (expectedOrigin ?? "")
    : (displayedOrigin ?? t("sourceAccess.originUnavailable"));
  const canVerifySourceAccess =
    phase === "ready" &&
    !browserLoading &&
    sourceId !== null &&
    displayedOrigin !== null &&
    sourceAccessContext !== null;

  const pageHost = siteHost(currentObservation?.url ?? currentUrl);
  const closeLabel = sourceAccessContext
    ? t("sourceAccess.closeKeepPaused")
    : t("siteBrowser.close");

  return (
    <div
      aria-describedby={
        sourceAccessContext ? "norea-site-browser-instructions" : undefined
      }
      aria-labelledby="norea-site-browser-title"
      aria-modal="true"
      className="norea-site-browser"
      role="dialog"
    >
      <PageHeader
        backLabel={closeLabel}
        className="norea-site-browser-bar"
        onBack={closeBrowser}
        title={
          sourceAccessContext ? (
            <>
              <span className="norea-site-browser-title-main">{sourceAccessTitle}</span>
              <span className="norea-site-browser-title-host">{displayedOriginLabel}</span>
            </>
          ) : (
            <span className="norea-site-browser-title-main">
              {pageHost ?? t("siteBrowser.title")}
            </span>
          )
        }
        titleElement="h2"
        titleId="norea-site-browser-title"
      />
      <SiteBrowserAddressBar
        key={`${browserTaskId}:${openSequence}`}
        url={currentObservation?.url ?? currentUrl ?? ""}
        loading={browserLoading}
        onNavigate={(url) => {
          if (browserTaskId) {
            useSiteBrowserStore.getState().navigateTo(browserTaskId, url);
          }
        }}
      />
      <div className="norea-site-browser-page" ref={placeholderRef}>
        {phase === "error" ? (
          <div className="norea-site-browser-cover norea-site-browser-error" role="alert">
            <div className="norea-site-browser-error-copy">
              <Text fw="var(--norea-weight-bold)">{t("siteBrowser.navigationFailed")}</Text>
              <Text c="dimmed" size="sm">
                {t("siteBrowser.navigationFailedDescription")}
              </Text>
              <Text className="norea-site-browser-error-detail" size="sm">
                {navigationError}
              </Text>
              <Button
                onClick={() => {
                  if (browserTaskId && currentUrl) {
                    useSiteBrowserStore.getState().navigateTo(browserTaskId, currentUrl);
                  }
                }}
              >
                {t("common.retry")}
              </Button>
            </div>
          </div>
        ) : browserLoading ? (
          <div aria-busy="true" className="norea-site-browser-cover" role="status">
            <Loader size="sm" />
            <Text>{t("common.loading")}</Text>
          </div>
        ) : null}
      </div>
      {sourceAccessContext ? (
        <footer className="norea-site-browser-footer" id="norea-site-browser-instructions">
          <Text size="sm">
            {sourceAccessContext.challenge.kind === "forbidden"
              ? t("errors.forbidden")
              : t("sourceAccess.browserInstructions", {
                  source: sourceAccessContext.sourceName,
                })}
          </Text>
          <div className="norea-site-browser-actions">
            <Button
              className="norea-site-browser-skip"
              color="danger"
              onClick={() =>
                cancelSourceAccessWait(
                  sourceAccessContext.scopeKey,
                  sourceAccessContext.revision,
                )
              }
              variant="subtle"
            >
              {t("sourceAccess.forceStopAndContinue")}
            </Button>
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
              onClick={() => {
                if (!sourceId) return;
                void verifySourceAccess(
                  browserTaskId,
                  sourceAccessContext.revision,
                  openSequence,
                  sourceAccessContext.scopeKey,
                  sourceId,
                );
              }}
            >
              {verifyLabel}
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
