import type { PointerEvent, RefObject, TouchEvent } from "react";
import { useEffect, useRef, type MouseEvent, type WheelEvent } from "react";
import {
  type ReaderGeneralSettings,
  type ReaderTapAction,
} from "../../store/reader";
import {
  getNormalizedWheelDelta,
  getReaderDebugSnapshot,
  getTapZone,
  hasReaderTextSelection,
  isInteractiveTarget,
  logReaderInput,
} from "./reader-content-metrics";
import { isReaderMediaEventTarget } from "./reader-content-media";
import { getReaderLinkElement, openReaderLink } from "./reader-links";
const WHEEL_PAGE_COOLDOWN_MS = 220;
const WHEEL_PAGE_DELTA_THRESHOLD = 20;
const NATIVE_WHEEL_ACTION_LOCK_MS = 240;
/** A mouse tap waits this long, so the first click of a double-click that selects a word does not page. */
const MOUSE_TAP_SETTLE_MS = 300;

interface ReaderGestureOptions {
  /** While dismissible chrome is visible, any tap hides it instead of paging. */
  chromeDismissible: boolean;
  interactionBlocked: boolean;
  isPagedReader: boolean;
  general: Pick<
    ReaderGeneralSettings,
    "tapToScroll" | "tapZones" | "swipeGestures"
  >;
  viewportRef: RefObject<HTMLDivElement | null>;
  getActiveScrollNode: () => HTMLDivElement | null;
  scrollByPage: (direction: 1 | -1, source?: string) => void;
  onToggleChrome?: () => void;
  nativeWheelActionLockedUntilRef: RefObject<number>;
}
export function useReaderGestures({
  chromeDismissible,
  interactionBlocked,
  isPagedReader,
  general,
  viewportRef,
  getActiveScrollNode,
  scrollByPage,
  onToggleChrome,
  nativeWheelActionLockedUntilRef,
}: ReaderGestureOptions) {
  const wheelDeltaRef = useRef(0);
  const wheelCooldownTimerRef = useRef<number | null>(null);
  const wheelPagingLockedRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectionAtPointerDownRef = useRef(false);
  const pointerTypeRef = useRef("");
  const pendingMouseTapTimerRef = useRef<number | null>(null);
  const clearPendingMouseTap = () => {
    if (pendingMouseTapTimerRef.current === null) return;
    window.clearTimeout(pendingMouseTapTimerRef.current);
    pendingMouseTapTimerRef.current = null;
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pointerTypeRef.current = event.pointerType;
    selectionAtPointerDownRef.current = hasReaderTextSelection();
  };
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = isReaderMediaEventTarget(event.target)
      ? null
      : getReaderLinkElement(event.target);
    if (link) {
      event.preventDefault();
      if (!interactionBlocked) openReaderLink(link);
      return;
    }
    if (interactionBlocked) return;
    if (isInteractiveTarget(event.target)) return;
    if (event.detail > 1) {
      clearPendingMouseTap();
      selectionAtPointerDownRef.current = false;
      return;
    }
    const selectionTap =
      selectionAtPointerDownRef.current || hasReaderTextSelection();
    selectionAtPointerDownRef.current = false;
    if (selectionTap) return;
    const runTap = resolveTap(event.clientX, event.clientY);
    if (!runTap) return;
    if (pointerTypeRef.current !== "mouse") {
      runTap();
      return;
    }
    clearPendingMouseTap();
    pendingMouseTapTimerRef.current = window.setTimeout(() => {
      pendingMouseTapTimerRef.current = null;
      if (!hasReaderTextSelection()) runTap();
    }, MOUSE_TAP_SETTLE_MS);
  };

  const resolveTap = (clientX: number, clientY: number): (() => void) | null => {
    if (chromeDismissible) return () => onToggleChrome?.();
    const node = viewportRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();

    const zone = getTapZone(rect, clientX, clientY);
    const action: ReaderTapAction =
      zone === "middleCenter"
        ? "menu"
        : general.tapToScroll
          ? general.tapZones[zone]
          : "none";

    switch (action) {
      case "previous":
        return () => scrollByPage(-1, "tap-previous");
      case "next":
        return () => scrollByPage(1, "tap-next");
      case "menu":
        return () => onToggleChrome?.();
      case "none":
        return null;
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (interactionBlocked || event.ctrlKey) return;
    if (isInteractiveTarget(event.target)) return;

    const delta = getNormalizedWheelDelta(event);
    if (Math.abs(delta) < 1) return;
    if (!isPagedReader) {
      nativeWheelActionLockedUntilRef.current =
        performance.now() + NATIVE_WHEEL_ACTION_LOCK_MS;
      return;
    }

    event.preventDefault();
    const node = getActiveScrollNode();
    if (wheelPagingLockedRef.current) {
      logReaderInput("wheel-suppressed", () => ({
        delta: Math.round(delta),
        reason: "wheel-cooldown",
        snapshot: getReaderDebugSnapshot(node),
      }));
      return;
    }

    wheelDeltaRef.current += delta;
    if (Math.abs(wheelDeltaRef.current) < WHEEL_PAGE_DELTA_THRESHOLD) {
      logReaderInput("wheel-accumulate", () => ({
        delta: Math.round(delta),
        accumulated: Math.round(wheelDeltaRef.current),
        snapshot: getReaderDebugSnapshot(node),
      }));
      return;
    }

    const direction: 1 | -1 = wheelDeltaRef.current > 0 ? 1 : -1;
    wheelDeltaRef.current = 0;
    wheelPagingLockedRef.current = true;
    logReaderInput("wheel-page-step", () => ({
      direction,
      snapshot: getReaderDebugSnapshot(node),
    }));
    scrollByPage(direction, "wheel-page-step");

    if (wheelCooldownTimerRef.current !== null) {
      window.clearTimeout(wheelCooldownTimerRef.current);
    }
    wheelCooldownTimerRef.current = window.setTimeout(() => {
      wheelPagingLockedRef.current = false;
      wheelCooldownTimerRef.current = null;
    }, WHEEL_PAGE_COOLDOWN_MS);
  };

  useEffect(
    () => () => {
      if (wheelCooldownTimerRef.current !== null) {
        window.clearTimeout(wheelCooldownTimerRef.current);
      }
      if (pendingMouseTapTimerRef.current !== null) {
        window.clearTimeout(pendingMouseTapTimerRef.current);
      }
    },
    [],
  );
  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (interactionBlocked) return;
    const touch = event.changedTouches[0];
    if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (interactionBlocked) {
      touchStartRef.current = null;
      return;
    }
    if (!general.swipeGestures || !touchStartRef.current) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (hasReaderTextSelection()) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      scrollByPage(dx < 0 ? 1 : -1, "swipe");
    }
  };
  return {
    handleClick,
    handlePointerDown,
    handleWheel,
    handleTouchStart,
    handleTouchEnd,
  };
}
