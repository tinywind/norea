import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChapterMediaStorageGate } from "./components/runtime/ChapterMediaStorageGate";
import { PluginVpnProxyGate } from "./components/runtime/PluginVpnProxyGate";
import { translate } from "./i18n";
import { describeError } from "./lib/errors";
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
import "./styles/app.css";
import { makeMantineColorScale, resolveMd3Palette } from "./theme/md3";

installRuntimeLogLevelFilter(useLoggingStore.getState().logLevel);

/**
 * Global error fallbacks for any mutation or query that doesn't
 * surface its own error UI. Silent-failure is the worst kind of
 * bug. Every mutation/query that throws gets a red toast at minimum.
 */
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) =>
      showErrorToast(
        translate(useAppearanceStore.getState().appLocale, "common.loadFailed"),
        error,
      ),
  }),
  mutationCache: new MutationCache({
    onError: (error) =>
      showErrorToast(
        translate(
          useAppearanceStore.getState().appLocale,
          "common.actionFailed",
        ),
        error,
      ),
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

function withAlpha(color: string, alpha: number): string {
  const rgbMatch = color.match(
    /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i,
  );
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }

  const hexMatch = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!hexMatch) return color;

  const hex = hexMatch[1];
  const channels =
    hex.length === 3
      ? hex.split("").map((part) => parseInt(part + part, 16))
      : [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
        ];

  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

function AppProviders() {
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
  const theme = useMemo(
    () =>
      createTheme({
        fontFamily:
          "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        primaryColor: "norea",
        colors: {
          norea: makeMantineColorScale(palette),
        },
        defaultRadius: "sm",
        components: {
          Alert: {
            defaultProps: {
              radius: "sm",
            },
          },
          Button: {
            defaultProps: {
              radius: "sm",
            },
          },
          Paper: {
            defaultProps: {
              radius: "sm",
            },
          },
          TextInput: {
            defaultProps: {
              radius: "sm",
            },
          },
        },
      }),
    [palette],
  );

  useEffect(() => {
    const root = document.documentElement;
    root.lang = appLocale;
    root.style.setProperty("--norea-background", palette.background);
    root.style.setProperty("--norea-on-background", palette.onBackground);
    root.style.setProperty("--norea-surface", palette.surface);
    root.style.setProperty("--norea-on-surface", palette.onSurface);
    root.style.setProperty("--norea-surface-variant", palette.surfaceVariant);
    root.style.setProperty(
      "--norea-on-surface-variant",
      palette.onSurfaceVariant,
    );
    root.style.setProperty("--norea-outline", palette.outlineVariant);
    root.style.setProperty("--norea-primary", palette.primary);
    root.style.setProperty("--norea-on-primary", palette.onPrimary);
    root.style.setProperty("--norea-design-bg", palette.background);
    root.style.setProperty("--norea-design-surface", palette.surface);
    root.style.setProperty("--norea-design-panel", palette.surfaceVariant);
    root.style.setProperty("--norea-design-ink", palette.onBackground);
    root.style.setProperty(
      "--norea-design-ink-muted",
      palette.onSurfaceVariant,
    );
    root.style.setProperty("--norea-design-ink-subtle", palette.outline);
    root.style.setProperty("--norea-design-rule", palette.outlineVariant);
    root.style.setProperty("--norea-design-rule-strong", palette.outline);
    root.style.setProperty("--norea-design-accent", palette.primary);
    root.style.setProperty("--norea-design-on-accent", palette.onPrimary);
    root.style.setProperty(
      "--norea-design-accent-soft",
      withAlpha(palette.primary, colorScheme === "dark" ? 0.18 : 0.1),
    );
    const warn = colorScheme === "dark" ? "#f0c36a" : "#9a6a1a";
    root.style.setProperty("--norea-design-warn", warn);
    root.style.setProperty(
      "--norea-design-warn-soft",
      withAlpha(warn, colorScheme === "dark" ? 0.16 : 0.08),
    );
    root.style.setProperty("--norea-design-error", palette.error);
    root.style.setProperty(
      "--norea-design-ok",
      colorScheme === "dark" ? "#7ecf91" : "#3a7a4a",
    );
    root.style.setProperty(
      "--norea-design-hover-overlay",
      colorScheme === "dark"
        ? "rgba(255, 255, 255, 0.08)"
        : "rgba(255, 255, 255, 0.65)",
    );
    root.style.setProperty(
      "--norea-design-selection-hover-overlay",
      colorScheme === "dark"
        ? "rgba(255, 255, 255, 0.14)"
        : "rgba(255, 255, 255, 0.55)",
    );
    root.style.setProperty(
      "--norea-design-shadow-floating",
      colorScheme === "dark"
        ? "0 0.5rem 1.5rem rgba(0, 0, 0, 0.42)"
        : "0 0.5rem 1.25rem rgba(15, 23, 42, 0.14)",
    );
    document.body.style.background = palette.background;
    document.body.style.color = palette.onBackground;
  }, [appLocale, colorScheme, palette]);

  useEffect(() => {
    setRuntimeLogLevel(logLevel);
  }, [logLevel]);

  useRuntimeViewport(fontScalePercent, androidViewScalePercent);

  return (
    <MantineProvider theme={theme} forceColorScheme={colorScheme}>
      <Notifications position="top-right" />
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
createRoot(rootElement).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
