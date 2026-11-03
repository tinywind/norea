import { useEffect } from "react";

const activeCounts = new Map<string, number>();

/**
 * Sets `data-norea-<name>` on `<body>` while any mounted caller passes
 * `active`. Page-wide CSS (the bottom navigation, the toast stack) reads it
 * instead of `body:has(...)`, which Android System WebView before 105 drops.
 */
export function useBodyFlag(name: string, active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const attribute = `data-norea-${name}`;
    activeCounts.set(name, (activeCounts.get(name) ?? 0) + 1);
    document.body.setAttribute(attribute, "true");
    return () => {
      const remaining = (activeCounts.get(name) ?? 1) - 1;
      if (remaining > 0) {
        activeCounts.set(name, remaining);
        return;
      }
      activeCounts.delete(name);
      document.body.removeAttribute(attribute);
    };
  }, [active, name]);
}
