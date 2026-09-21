import { useLayoutEffect, useRef, type ReactNode } from "react";
import { PageActivityContext } from "../lib/page-activity";

interface PageSlotProps {
  active: boolean;
  children: ReactNode;
}

/**
 * Keeps a page mounted while hidden and restores the shared scroll container
 * to where this page left it when it becomes active again. Hidden slots stay
 * laid out at their normal size (see `.norea-page-slot` in app.css) so
 * virtualized lists and reader progress never observe a collapsed viewport.
 */
export function PageSlot({ active, children }: PageSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const savedScrollTopRef = useRef(0);

  useLayoutEffect(() => {
    if (!active) return;
    const scrollContainer = slotRef.current?.parentElement;
    if (!scrollContainer) return;

    scrollContainer.scrollTop = savedScrollTopRef.current;
    const recordScrollTop = () => {
      savedScrollTopRef.current = scrollContainer.scrollTop;
    };
    scrollContainer.addEventListener("scroll", recordScrollTop, {
      passive: true,
    });
    return () => {
      scrollContainer.removeEventListener("scroll", recordScrollTop);
    };
  }, [active]);

  return (
    <PageActivityContext.Provider value={active}>
      <div
        aria-hidden={!active}
        className="norea-page-slot"
        data-active={active}
        inert={!active}
        ref={slotRef}
      >
        {children}
      </div>
    </PageActivityContext.Provider>
  );
}
