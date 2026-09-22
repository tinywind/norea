import { useEffect } from "react";
export function useReaderWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (type: "screen") => Promise<{ release: () => Promise<void> }>;
      };
    };
    let lock: { release: () => Promise<void> } | null = null;
    let disposed = false;
    void nav.wakeLock
      ?.request("screen")
      .then((nextLock) => {
        if (disposed) {
          void nextLock.release();
          return;
        }
        lock = nextLock;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (lock) void lock.release();
    };
  }, [enabled]);
}
