import {
  StrictMode,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  MantineProvider,
  Paper,
  Stack,
  Text,
  Title,
  createTheme,
} from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./styles/app.css";
import { RouterProvider } from "@tanstack/react-router";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  installRuntimeLogLevelFilter,
  setRuntimeLogLevel,
} from "./lib/logging";
import {
  getChapterMediaStorageRoot,
  selectChapterMediaStorageRoot,
} from "./lib/chapter-media-storage";
import { startChapterContentStorageMirrorSweep } from "./lib/chapter-content-storage";
import { pluginManager } from "./lib/plugins/manager";
import { isAndroidRuntime, isTauriRuntime } from "./lib/tauri-runtime";
import { router } from "./router";
import {
  normalizeAndroidViewScalePercent,
  normalizeFontScalePercent,
  useAppearanceStore,
} from "./store/appearance";
import { useLoggingStore } from "./store/logging";
import { translate } from "./i18n";
import { makeMantineColorScale, resolveMd3Palette } from "./theme/md3";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showErrorToast(title: string, error: unknown): void {
  notifications.show({
    color: "red",
    title,
    message: describeError(error),
    autoClose: 7_000,
  });
}

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
  console.error("[unhandledrejection]", event.reason);
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

const ROOT_FONT_SIZE_PX = 16;
const DEFAULT_VIEWPORT_META =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
const ANDROID_MIN_VIEWPORT_WIDTH = 320;
const ANDROID_MAX_VIEWPORT_WIDTH = 1920;
const ANDROID_ENTER_BLUR_INPUT_TYPES = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);
const MANTINE_XS_MIN_WIDTH = 576;
const MANTINE_SM_MIN_WIDTH = 768;
const MANTINE_MD_MIN_WIDTH = 992;
const MANTINE_LG_MIN_WIDTH = 1200;
const MANTINE_XL_MIN_WIDTH = 1408;

type AndroidLayoutClass = "base" | "xs" | "sm" | "md" | "lg" | "xl";

interface AndroidSafeAreaBridge {
  getInsets(): string;
}

interface AndroidWindowBridge {
  getMetrics(): string;
}

interface RuntimeSafeAreaInsets {
  bottom?: unknown;
  left?: unknown;
  right?: unknown;
  top?: unknown;
}

interface RuntimeWindowMetrics {
  density?: unknown;
  heightDp?: unknown;
  heightPx?: unknown;
  widthDp?: unknown;
  widthPx?: unknown;
}

declare global {
  interface Window {
    __NoreaAndroidSafeArea?: AndroidSafeAreaBridge;
    __NoreaAndroidWindow?: AndroidWindowBridge;
    __lnrApplyAndroidSafeAreaInsets?: (insets: RuntimeSafeAreaInsets) => void;
  }
}

interface AndroidLayoutConfig {
  className: AndroidLayoutClass;
  nativePxPerCssPx: number;
  viewportWidth: number;
}

let androidNativePxPerCssPx = 1;

function positiveNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? numeric
    : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function classifyAndroidLayout(width: number): AndroidLayoutClass {
  if (width >= MANTINE_XL_MIN_WIDTH) return "xl";
  if (width >= MANTINE_LG_MIN_WIDTH) return "lg";
  if (width >= MANTINE_MD_MIN_WIDTH) return "md";
  if (width >= MANTINE_SM_MIN_WIDTH) return "sm";
  if (width >= MANTINE_XS_MIN_WIDTH) return "xs";
  return "base";
}

function readAndroidWindowMetrics(): RuntimeWindowMetrics | null {
  const raw = window.__NoreaAndroidWindow?.getMetrics();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as RuntimeWindowMetrics)
      : null;
  } catch {
    return null;
  }
}

function resolveAndroidViewportWidth(
  viewportWidth: number,
  androidViewScalePercent: unknown,
): number {
  const scale = normalizeAndroidViewScalePercent(androidViewScalePercent) / 100;
  return viewportWidth * (1 / scale);
}

function resolveFallbackAndroidLayout(
  androidViewScalePercent: unknown,
): AndroidLayoutConfig {
  const density =
    Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  const fallbackWidth =
    positiveNumber(window.screen?.availWidth) ??
    positiveNumber(window.screen?.width) ??
    window.innerWidth;
  const widthPx = fallbackWidth >= MANTINE_SM_MIN_WIDTH
    ? fallbackWidth
    : fallbackWidth * density;
  const baseViewportWidth = clamp(
    widthPx / density,
    ANDROID_MIN_VIEWPORT_WIDTH,
    ANDROID_MAX_VIEWPORT_WIDTH,
  );
  const viewportWidth = resolveAndroidViewportWidth(
    baseViewportWidth,
    androidViewScalePercent,
  );

  return {
    className: classifyAndroidLayout(viewportWidth),
    nativePxPerCssPx: widthPx / viewportWidth,
    viewportWidth,
  };
}

function resolveAndroidLayout(
  androidViewScalePercent: unknown,
): AndroidLayoutConfig {
  const metrics = readAndroidWindowMetrics();
  if (!metrics) return resolveFallbackAndroidLayout(androidViewScalePercent);

  const widthDp = positiveNumber(metrics.widthDp);
  const widthPx = positiveNumber(metrics.widthPx);
  const density = positiveNumber(metrics.density);
  const rawViewportWidth =
    widthDp ?? (widthPx && density ? widthPx / density : null);

  if (!rawViewportWidth) {
    return resolveFallbackAndroidLayout(androidViewScalePercent);
  }

  const baseViewportWidth = clamp(
    rawViewportWidth,
    ANDROID_MIN_VIEWPORT_WIDTH,
    ANDROID_MAX_VIEWPORT_WIDTH,
  );
  const viewportWidth = resolveAndroidViewportWidth(
    baseViewportWidth,
    androidViewScalePercent,
  );
  const physicalWidthPx =
    widthPx ?? (density ? baseViewportWidth * density : null);
  const nativePxPerCssPx =
    physicalWidthPx && physicalWidthPx > 0
      ? physicalWidthPx / viewportWidth
      : density ?? 1;

  return {
    className: classifyAndroidLayout(viewportWidth),
    nativePxPerCssPx,
    viewportWidth,
  };
}

function viewportMeta(): HTMLMetaElement | null {
  return document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
}

function applyAndroidViewport(width: number): void {
  const viewport = viewportMeta();
  if (!viewport) return;
  const content =
    `width=${Math.round(width)}, initial-scale=1.0, maximum-scale=1.0, ` +
    "user-scalable=no, viewport-fit=cover";
  if (viewport.content !== content) {
    viewport.content = content;
  }
}

function resetViewportScale(): void {
  const viewport = viewportMeta();
  if (viewport && viewport.content !== DEFAULT_VIEWPORT_META) {
    viewport.content = DEFAULT_VIEWPORT_META;
  }
}

function safeInsetPx(value: unknown, roundUp = false): string {
  const numeric = typeof value === "number" ? value : Number(value);
  const nativePxPerCssPx = isAndroidRuntime() ? androidNativePxPerCssPx : 1;
  const cssPixels =
    (Number.isFinite(numeric) ? numeric : 0) / nativePxPerCssPx;
  const rounded = roundUp
    ? Math.ceil(cssPixels - 0.001)
    : Math.round(cssPixels);
  return `${Math.max(0, rounded)}px`;
}

function applyNativeSafeAreaInsets(insets: RuntimeSafeAreaInsets): void {
  const root = document.documentElement;
  root.style.setProperty(
    "--lnr-native-safe-area-top",
    safeInsetPx(insets.top, true),
  );
  root.style.setProperty(
    "--lnr-native-safe-area-right",
    safeInsetPx(insets.right),
  );
  root.style.setProperty(
    "--lnr-native-safe-area-bottom",
    safeInsetPx(insets.bottom),
  );
  root.style.setProperty(
    "--lnr-native-safe-area-left",
    safeInsetPx(insets.left),
  );
}

function readAndroidSafeAreaInsets(): RuntimeSafeAreaInsets | null {
  const raw = window.__NoreaAndroidSafeArea?.getInsets();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as RuntimeSafeAreaInsets)
      : null;
  } catch {
    return null;
  }
}

function clearNativeSafeAreaInsets(): void {
  const root = document.documentElement;
  root.style.removeProperty("--lnr-native-safe-area-top");
  root.style.removeProperty("--lnr-native-safe-area-right");
  root.style.removeProperty("--lnr-native-safe-area-bottom");
  root.style.removeProperty("--lnr-native-safe-area-left");
}

function applyRuntimeSafeAreaInsets(): void {
  if (!isAndroidRuntime()) {
    clearNativeSafeAreaInsets();
    return;
  }
  const insets = readAndroidSafeAreaInsets();
  if (insets) {
    applyNativeSafeAreaInsets(insets);
  }
}

function applyRuntimeUiScale(
  fontScalePercent = useAppearanceStore.getState().fontScalePercent,
  androidViewScalePercent =
    useAppearanceStore.getState().androidViewScalePercent,
): void {
  const root = document.documentElement;
  const fontScale = normalizeFontScalePercent(fontScalePercent) / 100;
  root.style.setProperty(
    "--lnr-root-font-size",
    `${ROOT_FONT_SIZE_PX * fontScale}px`,
  );
  root.style.setProperty("--lnr-ui-scale", fontScale.toFixed(3));

  if (!isAndroidRuntime()) {
    resetViewportScale();
    delete root.dataset.lnrPlatform;
    delete root.dataset.lnrAndroidLayout;
    root.style.removeProperty("--lnr-mobile-nav-content-height");
    androidNativePxPerCssPx = 1;
    clearNativeSafeAreaInsets();
    return;
  }

  const layout = resolveAndroidLayout(androidViewScalePercent);
  androidNativePxPerCssPx = layout.nativePxPerCssPx;
  root.dataset.lnrPlatform = "android";
  root.dataset.lnrAndroidLayout = layout.className;
  applyAndroidViewport(layout.viewportWidth);
  root.style.removeProperty("--lnr-mobile-nav-content-height");
}

function isAndroidEnterBlurInput(
  target: EventTarget | null,
): target is HTMLInputElement {
  return (
    target instanceof HTMLInputElement &&
    !target.disabled &&
    !target.readOnly &&
    ANDROID_ENTER_BLUR_INPUT_TYPES.has(target.type)
  );
}

function blurAndroidInputOnEnter(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.isComposing) return;
  if (!isAndroidEnterBlurInput(event.target)) return;

  const target = event.target;
  window.setTimeout(() => {
    if (document.activeElement === target) target.blur();
  }, 0);
}

window.__lnrApplyAndroidSafeAreaInsets = (insets) => {
  if (isAndroidRuntime()) {
    applyNativeSafeAreaInsets(insets);
  }
};

applyRuntimeUiScale();
applyRuntimeSafeAreaInsets();

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
  const rgbMatch = color.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
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

interface ChapterMediaStorageGateProps {
  children: ReactNode;
}

function ChapterMediaStorageGate({
  children,
}: ChapterMediaStorageGateProps) {
  const appLocale = useAppearanceStore((state) => state.appLocale);
  const [checking, setChecking] = useState(isTauriRuntime());
  const [storageReady, setStorageReady] = useState(!isTauriRuntime());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let cancelled = false;
    void getChapterMediaStorageRoot()
      .then((root) => {
        if (cancelled) return;
        if (isAndroidRuntime()) {
          setStorageReady(root?.trim().startsWith("content://") === true);
          return;
        }
        setStorageReady(root !== null && root.trim() !== "");
      })
      .catch((unknownError: unknown) => {
        if (cancelled) return;
        setError(describeError(unknownError));
        setStorageReady(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || !isTauriRuntime()) return;

    const stopMirrorSweep = startChapterContentStorageMirrorSweep();
    void pluginManager.loadInstalledFromDb().catch((unknownError: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(
        "[bootstrap] failed to rehydrate installed plugins",
        unknownError,
      );
    });
    return stopMirrorSweep;
  }, [storageReady]);

  async function chooseStorageRoot(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const root = await selectChapterMediaStorageRoot();
      if (root) {
        setStorageReady(true);
      }
    } catch (unknownError) {
      setError(describeError(unknownError));
    } finally {
      setBusy(false);
      setChecking(false);
    }
  }

  if (checking) {
    return (
      <div className="lnr-storage-setup">
        <Paper className="lnr-storage-setup-card" withBorder>
          <Text>{translate(appLocale, "storageSetup.checking")}</Text>
        </Paper>
      </div>
    );
  }

  if (!storageReady) {
    return (
      <div className="lnr-storage-setup">
        <Paper className="lnr-storage-setup-card" withBorder>
          <Stack gap="md">
            <Stack gap="xs">
              <Title order={1} className="lnr-storage-setup-title">
                {translate(appLocale, "storageSetup.title")}
              </Title>
              <Text className="lnr-storage-setup-copy">
                {translate(
                  appLocale,
                  isAndroidRuntime()
                    ? "storageSetup.androidDefaultDescription"
                    : "storageSetup.description",
                )}
              </Text>
            </Stack>
            {error ? (
              <Text className="lnr-storage-setup-error" role="alert">
                {translate(appLocale, "storageSetup.failed", { error })}
              </Text>
            ) : null}
            <Button
              loading={busy}
              onClick={() => {
                void chooseStorageRoot();
              }}
            >
              {translate(
                appLocale,
                isAndroidRuntime()
                  ? "storageSetup.useAppStorage"
                  : "storageSetup.selectFolder",
              )}
            </Button>
          </Stack>
        </Paper>
      </div>
    );
  }

  return children;
}

function AppProviders() {
  const appLocale = useAppearanceStore((state) => state.appLocale);
  const appThemeId = useAppearanceStore((state) => state.appThemeId);
  const androidViewScalePercent = useAppearanceStore(
    (state) => state.androidViewScalePercent,
  );
  const fontScalePercent = useAppearanceStore((state) => state.fontScalePercent);
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
    root.style.setProperty("--lnr-background", palette.background);
    root.style.setProperty("--lnr-on-background", palette.onBackground);
    root.style.setProperty("--lnr-surface", palette.surface);
    root.style.setProperty("--lnr-on-surface", palette.onSurface);
    root.style.setProperty("--lnr-surface-variant", palette.surfaceVariant);
    root.style.setProperty(
      "--lnr-on-surface-variant",
      palette.onSurfaceVariant,
    );
    root.style.setProperty("--lnr-outline", palette.outlineVariant);
    root.style.setProperty("--lnr-primary", palette.primary);
    root.style.setProperty("--lnr-on-primary", palette.onPrimary);
    root.style.setProperty("--lnr-design-bg", palette.background);
    root.style.setProperty("--lnr-design-surface", palette.surface);
    root.style.setProperty("--lnr-design-panel", palette.surfaceVariant);
    root.style.setProperty("--lnr-design-ink", palette.onBackground);
    root.style.setProperty("--lnr-design-ink-muted", palette.onSurfaceVariant);
    root.style.setProperty("--lnr-design-ink-subtle", palette.outline);
    root.style.setProperty("--lnr-design-rule", palette.outlineVariant);
    root.style.setProperty("--lnr-design-rule-strong", palette.outline);
    root.style.setProperty("--lnr-design-accent", palette.primary);
    root.style.setProperty("--lnr-design-on-accent", palette.onPrimary);
    root.style.setProperty(
      "--lnr-design-accent-soft",
      withAlpha(palette.primary, colorScheme === "dark" ? 0.18 : 0.1),
    );
    const warn = colorScheme === "dark" ? "#f0c36a" : "#9a6a1a";
    root.style.setProperty("--lnr-design-warn", warn);
    root.style.setProperty(
      "--lnr-design-warn-soft",
      withAlpha(warn, colorScheme === "dark" ? 0.16 : 0.08),
    );
    root.style.setProperty("--lnr-design-error", palette.error);
    root.style.setProperty(
      "--lnr-design-ok",
      colorScheme === "dark" ? "#7ecf91" : "#3a7a4a",
    );
    root.style.setProperty(
      "--lnr-design-hover-overlay",
      colorScheme === "dark"
        ? "rgba(255, 255, 255, 0.08)"
        : "rgba(255, 255, 255, 0.65)",
    );
    root.style.setProperty(
      "--lnr-design-selection-hover-overlay",
      colorScheme === "dark"
        ? "rgba(255, 255, 255, 0.14)"
        : "rgba(255, 255, 255, 0.55)",
    );
    root.style.setProperty(
      "--lnr-design-shadow-floating",
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

  useEffect(() => {
    applyRuntimeUiScale(fontScalePercent, androidViewScalePercent);
    applyRuntimeSafeAreaInsets();
  }, [androidViewScalePercent, fontScalePercent]);

  useEffect(() => {
    if (!isAndroidRuntime()) return;

    document.addEventListener("keydown", blurAndroidInputOnEnter, true);
    return () => {
      document.removeEventListener("keydown", blurAndroidInputOnEnter, true);
    };
  }, []);

  useEffect(() => {
    if (!isAndroidRuntime()) return;

    let frame = 0;
    const scheduleRuntimeUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        applyRuntimeUiScale(fontScalePercent, androidViewScalePercent);
        applyRuntimeSafeAreaInsets();
      });
    };

    scheduleRuntimeUpdate();
    window.addEventListener("resize", scheduleRuntimeUpdate);
    window.visualViewport?.addEventListener("resize", scheduleRuntimeUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleRuntimeUpdate);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleRuntimeUpdate);
      window.visualViewport?.removeEventListener("resize", scheduleRuntimeUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleRuntimeUpdate);
    };
  }, [androidViewScalePercent, fontScalePercent]);

  return (
    <MantineProvider theme={theme} forceColorScheme={colorScheme}>
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <ChapterMediaStorageGate>
          <RouterProvider router={router} />
        </ChapterMediaStorageGate>
      </QueryClientProvider>
    </MantineProvider>
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
