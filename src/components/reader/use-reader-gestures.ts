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
  isInteractiveTarget,
  logReaderInput,
} from "./reader-content-metrics";
const WHEEL_PAGE_COOLDOWN_MS = 220;
const WHEEL_PAGE_DELTA_THRESHOLD = 20;
const NATIVE_WHEEL_ACTION_LOCK_MS = 240;

interface ReaderGestureOptions {
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
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (interactionBlocked) return;
    if (isInteractiveTarget(event.target)) return;
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
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      scrollByPage(dx < 0 ? 1 : -1, "swipe");
    }
  };
  return { handleClick, handleWheel, handleTouchStart, handleTouchEnd };
}
