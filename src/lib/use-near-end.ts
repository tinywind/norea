import { useEffect, useRef, useState } from "react";
import { usePageActivity } from "./page-activity";

/** One viewport of lookahead below the visible end of the list. */
const NEAR_END_ROOT_MARGIN = "0px 0px 100% 0px";

/**
 * Calls `onNearEnd` once when the returned ref's element comes within a
 * viewport of the visible area. The observer disconnects after each call
 * and re-arms only when `enabled` turns true again, so a caller that turns
 * `enabled` off while its request is in flight gets one request at a time.
 * Inactive page slots never trigger it.
 */
export function useNearEnd(
  enabled: boolean,
  onNearEnd: () => void,
): (element: Element | null) => void {
  const [element, setElement] = useState<Element | null>(null);
  const pageActive = usePageActivity();
  const onNearEndRef = useRef(onNearEnd);

  useEffect(() => {
    onNearEndRef.current = onNearEnd;
  }, [onNearEnd]);

  useEffect(() => {
    if (!enabled || !pageActive || !element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        onNearEndRef.current();
      },
      { rootMargin: NEAR_END_ROOT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled, pageActive]);

  return setElement;
}
