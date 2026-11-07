import { useLayoutEffect, useState, type RefObject } from "react";

/** Re-measures pages when fonts or local media settle after the document was mounted. */
export function useReaderLayoutRevision(
  contentRef: RefObject<HTMLDivElement | null>,
  renderedHtml: string,
): number {
  const [revision, setRevision] = useState(0);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let disposed = false;
    let frame: number | null = null;
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (!disposed) setRevision(value => value + 1);
      });
    };
    const fonts = content.ownerDocument?.fonts;
    content.addEventListener("load", schedule, true);
    content.addEventListener("error", schedule, true);
    fonts?.addEventListener("loadingdone", schedule);
    void fonts?.ready.then(schedule, schedule);
    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      content.removeEventListener("load", schedule, true);
      content.removeEventListener("error", schedule, true);
      fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [contentRef, renderedHtml]);
  return revision;
}
