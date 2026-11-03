import type { RefObject, TouchEvent } from "react";
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
import { getReaderLinkElement, openReaderLink } from "./reader-links";
const WHEEL_PAGE_COOLDOWN_MS = 220;
const WHEEL_PAGE_DELTA_THRESHOLD = 20;
const NATIVE_WHEEL_ACTION_LOCK_MS = 240;

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
  const handlePointerDown = () => {
    selectionAtPointerDownRef.current = hasReaderTextSelection();
  };
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = getReaderLinkElement(event.target);
    if (link) {
      event.preventDefault();
      if (!interactionBlocked) openReaderLink(link);
      return;
    }
    if (interactionBlocked) return;
    if (isInteractiveTarget(event.target)) return;
    const selectionTap =
      selectionAtPointerDownRef.current || hasReaderTextSelection();
    selectionAtPointerDownRef.current = false;
    if (selectionTap) return;
    if (chromeDismissible) {
      onToggleChrome?.();
      return;
    }
    const node = viewportRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();

    const zone = getTapZone(rect, event.clientX, event.clientY);
    const action: ReaderTapAction =
      zone === "middleCenter"
        ? "menu"
        : general.tapToScroll
          ? general.tapZones[zone]
          : "none";

    switch (action) {
      case "previous":
        scrollByPage(-1, "tap-previous");
        break;
      case "next":
        scrollByPage(1, "tap-next");
        break;
      case "menu":
        onToggleChrome?.();
        break;
      case "none":
        break;
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
