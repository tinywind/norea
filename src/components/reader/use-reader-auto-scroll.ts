import { useEffect, type RefObject } from "react";

export function useReaderAutoScroll(
  viewportRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  intervalMs: number,
  offset: number,
) {
  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(() => {
      const node = viewportRef.current;
      if (!node) return;
      node.scrollBy({ top: offset, behavior: "auto" });
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [enabled, intervalMs, offset, viewportRef]);
}
