import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  hashKey,
} from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChapterMediaStorageGate } from "./components/runtime/ChapterMediaStorageGate";
import { PluginVpnProxyGate } from "./components/runtime/PluginVpnProxyGate";
import { translate } from "./i18n";
import { describeError } from "./lib/errors";
import { startContentServerSync } from "./lib/content-sync/scheduler";
import { initializeNetworkStatus } from "./lib/network";
import { initializeTaskNetworkState } from "./lib/tasks/network-lifecycle";
import { initializeVpnDownloadRuntime } from "./lib/tasks/vpn-download-runtime";
import {
  installRuntimeLogLevelFilter,
  setRuntimeLogLevel,
} from "./lib/logging";
import { showErrorToast } from "./lib/runtime/error-toast";
import {
  initializeRuntimeViewport,
  useRuntimeViewport,
} from "./lib/runtime/viewport";
import { initializeSourceAccessCoordinator } from "./lib/tasks/source-access-coordinator";
import { redactUrlsForLog } from "./lib/url-log";
import { router } from "./router";
import { useAppearanceStore } from "./store/appearance";
import { useLoggingStore } from "./store/logging";
import "./theme/tokens.css";
import "./styles/app.css";
import "./styles/ui.css";
import { createNoreaMantineTheme } from "./theme/mantine-theme";
import { normalizeCustomAccentColor, resolveMd3Palette } from "./theme/md3";
import {
  paletteRoleCssVariables,
  resolvePaletteRoles,
} from "./theme/palette-roles";

installRuntimeLogLevelFilter(useLoggingStore.getState().logLevel);

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.meta?.errorPresentation === "inline") return;
      showErrorToast(
        translate(useAppearanceStore.getState().appLocale, "common.loadFailed"),
        error,
        query.meta?.errorToastGroup ?? `query:${query.queryHash}`,
      );
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (
        mutation.meta?.errorPresentation === "inline" ||
        (mutation.options.onError && mutation.meta?.errorPresentation !== "toast")
      ) {
        return;
      }
      showErrorToast(
        translate(
          useAppearanceStore.getState().appLocale,
          "common.actionFailed",
        ),
        error,
        mutation.meta?.errorToastGroup ??
          `mutation:${hashKey(mutation.options.mutationKey ?? [describeError(error)])}`,
      );
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
    },
  },
});

/**
 * Rehydrate previously-installed plugins from the DB at app start.
 * Fire-and-forget; failures get logged but don't block boot.
 */
/**
 * Async errors that escape React Query entirely get logged for
 * devtools but are not toasted; plugin-side scrape failures during
 * global search would otherwise spam the user with one toast per
 * plugin.
 */
window.addEventListener("unhandledrejection", (event) => {
  // eslint-disable-next-line no-console
  console.error(
    "[unhandledrejection]",
    redactUrlsForLog(describeError(event.reason)),
  );
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

initializeRuntimeViewport();

function useResolvedColorScheme(): "light" | "dark" {
  const themeMode = useAppearanceStore((state) => state.themeMode);
  const [prefersDark, setPrefersDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    if (themeMode !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(query.matches);
    const listener = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [themeMode]);

  if (themeMode === "light" || themeMode === "dark") {
    return themeMode;
  }
  return prefersDark ? "dark" : "light";
}

function AppProviders() {
  useEffect(() => startContentServerSync(), []);
  useEffect(() => {
    const refresh = () => {
      for (const key of ["novel", "chapter", "download-cache"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    };
    window.addEventListener("norea-content-state-changed", refresh);
    return () => window.removeEventListener("norea-content-state-changed", refresh);
  }, []);
  const appLocale = useAppearanceStore((state) => state.appLocale);
  const appThemeId = useAppearanceStore((state) => state.appThemeId);
  const androidViewScalePercent = useAppearanceStore(
    (state) => state.androidViewScalePercent,
  );
  const fontScalePercent = useAppearanceStore(
    (state) => state.fontScalePercent,
  );
  const amoledBlack = useAppearanceStore((state) => state.amoledBlack);
  const customAccentColor = useAppearanceStore(
    (state) => state.customAccentColor,
  );
  const logLevel = useLoggingStore((state) => state.logLevel);
  const colorScheme = useResolvedColorScheme();
  const palette = useMemo(
    () =>
      resolveMd3Palette(appThemeId, colorScheme, {
        amoledBlack,
        customAccentColor,
      }),
    [amoledBlack, appThemeId, colorScheme, customAccentColor],
  );
  const roles = useMemo(
    () =>
      resolvePaletteRoles(palette, colorScheme, {
        customAccent: normalizeCustomAccentColor(customAccentColor) !== undefined,
      }),
    [colorScheme, customAccentColor, palette],
  );
  const mantineTheme = useMemo(
    () => createNoreaMantineTheme(roles, colorScheme),
    [colorScheme, roles],
  );

  useEffect(() => {
    const root = document.documentElement;
    root.lang = appLocale;
    for (const [name, value] of Object.entries(
      paletteRoleCssVariables(roles),
    )) {
      root.style.setProperty(name, value);
    }
    document.body.style.background = roles.bg;
    document.body.style.color = roles.ink;
  }, [appLocale, roles]);

  useEffect(() => {
    setRuntimeLogLevel(logLevel);
  }, [logLevel]);

  useRuntimeViewport(fontScalePercent, androidViewScalePercent);

  return (
    <MantineProvider
      theme={mantineTheme.theme}
      cssVariablesResolver={mantineTheme.cssVariablesResolver}
      forceColorScheme={colorScheme}
    >
      <Notifications position="top-right" autoClose={5_000} />
      <QueryClientProvider client={queryClient}>
        <PluginVpnProxyGate>
          <ChapterMediaStorageGate>
            <RouterProvider router={router} />
          </ChapterMediaStorageGate>
        </PluginVpnProxyGate>
      </QueryClientProvider>
    </MantineProvider>
  );
}

initializeSourceAccessCoordinator();
void initializeNetworkStatus();
initializeTaskNetworkState();
void initializeVpnDownloadRuntime().catch(error => console.error("[vpn-download] initialization failed", error));
createRoot(rootElement).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
