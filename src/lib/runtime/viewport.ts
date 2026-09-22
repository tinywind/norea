import { useEffect } from "react";
import {
  normalizeAndroidViewScalePercent,
  normalizeFontScalePercent,
  useAppearanceStore,
} from "../../store/appearance";
import { isAndroidRuntime } from "../tauri-runtime";

const ROOT_FONT_SIZE_PX = 16;
const DEFAULT_VIEWPORT_META =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
const NATIVE_SAFE_AREA_TOP_PROPERTY = "--norea-native-safe-area-top";
const NATIVE_SAFE_AREA_RIGHT_PROPERTY = "--norea-native-safe-area-right";
const NATIVE_SAFE_AREA_BOTTOM_PROPERTY = "--norea-native-safe-area-bottom";
const NATIVE_SAFE_AREA_LEFT_PROPERTY = "--norea-native-safe-area-left";
const MOBILE_NAV_CONTENT_HEIGHT_PROPERTY = "--norea-mobile-nav-content-height";
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
    __noreaApplyAndroidSafeAreaInsets?: (insets: RuntimeSafeAreaInsets) => void;
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
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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
  const widthPx =
    fallbackWidth >= MANTINE_SM_MIN_WIDTH
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
      : (density ?? 1);

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
  const cssPixels = (Number.isFinite(numeric) ? numeric : 0) / nativePxPerCssPx;
  const rounded = roundUp
    ? Math.ceil(cssPixels - 0.001)
    : Math.round(cssPixels);
  return `${Math.max(0, rounded)}px`;
}

function applyNativeSafeAreaInsets(insets: RuntimeSafeAreaInsets): void {
  const root = document.documentElement;
  root.style.setProperty(
    NATIVE_SAFE_AREA_TOP_PROPERTY,
    safeInsetPx(insets.top, true),
  );
  root.style.setProperty(
    NATIVE_SAFE_AREA_RIGHT_PROPERTY,
    safeInsetPx(insets.right),
  );
  root.style.setProperty(
    NATIVE_SAFE_AREA_BOTTOM_PROPERTY,
    safeInsetPx(insets.bottom),
  );
  root.style.setProperty(
    NATIVE_SAFE_AREA_LEFT_PROPERTY,
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
  root.style.removeProperty(NATIVE_SAFE_AREA_TOP_PROPERTY);
  root.style.removeProperty(NATIVE_SAFE_AREA_RIGHT_PROPERTY);
  root.style.removeProperty(NATIVE_SAFE_AREA_BOTTOM_PROPERTY);
  root.style.removeProperty(NATIVE_SAFE_AREA_LEFT_PROPERTY);
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
  androidViewScalePercent = useAppearanceStore.getState()
    .androidViewScalePercent,
): void {
  const root = document.documentElement;
  const fontScale = normalizeFontScalePercent(fontScalePercent) / 100;
  root.style.setProperty(
    "--norea-root-font-size",
    `${ROOT_FONT_SIZE_PX * fontScale}px`,
  );
  root.style.setProperty("--norea-ui-scale", fontScale.toFixed(3));

  if (!isAndroidRuntime()) {
    resetViewportScale();
    delete root.dataset.noreaPlatform;
    delete root.dataset.noreaAndroidLayout;
    root.style.removeProperty(MOBILE_NAV_CONTENT_HEIGHT_PROPERTY);
    androidNativePxPerCssPx = 1;
    clearNativeSafeAreaInsets();
    return;
  }

  const layout = resolveAndroidLayout(androidViewScalePercent);
  androidNativePxPerCssPx = layout.nativePxPerCssPx;
  root.dataset.noreaPlatform = "android";
  root.dataset.noreaAndroidLayout = layout.className;
  applyAndroidViewport(layout.viewportWidth);
  root.style.removeProperty(MOBILE_NAV_CONTENT_HEIGHT_PROPERTY);
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

export function initializeRuntimeViewport(): void {
  window.__noreaApplyAndroidSafeAreaInsets = (insets) => {
    if (isAndroidRuntime()) {
      applyNativeSafeAreaInsets(insets);
    }
  };

  applyRuntimeUiScale();
  applyRuntimeSafeAreaInsets();
}

export function useRuntimeViewport(
  fontScalePercent: number,
  androidViewScalePercent: number,
): void {
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
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleRuntimeUpdate,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        scheduleRuntimeUpdate,
      );
    };
  }, [androidViewScalePercent, fontScalePercent]);
}
