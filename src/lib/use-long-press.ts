import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

/**
 * Long-press detection for a pressable element. `pressing` is true for the
 * press-and-hold window, so the element can show a held state before the long
 * press fires.
 */
export function useLongPress(onLongPress: (() => void) | undefined, delayMs: number) {
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPressing(false);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    firedRef.current = false;
    cancel();
    if (!onLongPress || event.button !== 0) return;
    setPressing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      setPressing(false);
      onLongPress();
    }, delayMs);
  };

  return {
    /** Whether the current press already fired the long press. */
    fired: () => firedRef.current,
    /** Reads and clears `fired`, for the click that ends a long press. */
    consumeFired: () => {
      const fired = firedRef.current;
      firedRef.current = false;
      return fired;
    },
    handlers: {
      onPointerCancel: cancel,
      onPointerDown,
      onPointerLeave: cancel,
      onPointerUp: cancel,
    },
    pressing,
  };
}
