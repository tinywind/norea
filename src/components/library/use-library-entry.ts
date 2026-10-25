import { useEffect } from "react";
import { useLibraryStore } from "../../store/library";

export function useLibraryEntry(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const initialize = () => useLibraryStore.getState().enterLibrary();
    const unsubscribe = useLibraryStore.persist?.onFinishHydration(initialize);
    initialize();
    return unsubscribe;
  }, [active]);
}
