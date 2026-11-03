import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Device-local reader layout. It stays out of `reader-settings`, so portable
 * backups and other devices keep their own panel choice.
 */
interface ReaderLayoutState {
  chapterPanelOpen: boolean;
  setChapterPanelOpen: (open: boolean) => void;
}

export const useReaderLayoutStore = create<ReaderLayoutState>()(
  persist(
    (set) => ({
      chapterPanelOpen: true,
      setChapterPanelOpen: (open) => set({ chapterPanelOpen: open }),
    }),
    {
      name: "reader-layout",
      merge: (persisted, current) => ({
        ...current,
        chapterPanelOpen:
          typeof (persisted as Partial<ReaderLayoutState> | null)
            ?.chapterPanelOpen === "boolean"
            ? (persisted as ReaderLayoutState).chapterPanelOpen
            : current.chapterPanelOpen,
      }),
      partialize: (state) => ({ chapterPanelOpen: state.chapterPanelOpen }),
    },
  ),
);
