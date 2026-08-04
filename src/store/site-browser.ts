import { create } from "zustand";

export type SiteBrowserPhase = "closed" | "queued" | "loading" | "ready";

interface SiteBrowserState {
  /** Whether the in-app site browser overlay is currently shown. */
  visible: boolean;
  /** The URL the scraper Webview should be navigated to on open. */
  currentUrl: string | null;
  /** Scheduler task that owns the current browser request. */
  taskId: string | null;
  /** Whether the request is queued, navigating, ready, or closed. */
  phase: SiteBrowserPhase;
  /** Monotonic sequence for repeated open requests, including the same URL. */
  openSequence: number;
  /** Show blocking browser chrome while the scheduler request is queued. */
  queueAt: (url: string, taskId: string) => void;
  /** Start native navigation after the scheduler assigns the executor. */
  startLoading: (url: string, taskId: string) => void;
  /** Mark the current native page as ready for interaction. */
  markReady: (taskId: string) => void;
  /** Hide the overlay. The scraper Webview is collapsed but kept alive. */
  hide: () => void;
}

export const useSiteBrowserStore = create<SiteBrowserState>((set) => ({
  visible: false,
  currentUrl: null,
  taskId: null,
  phase: "closed",
  openSequence: 0,
  queueAt: (url, taskId) =>
    set({
      visible: true,
      currentUrl: url,
      taskId,
      phase: "queued",
    }),
  startLoading: (url, taskId) =>
    set((state) =>
      state.visible && state.currentUrl === url && state.taskId === taskId
        ? {
            phase: "loading",
            openSequence: state.openSequence + 1,
          }
        : state,
    ),
  markReady: (taskId) =>
    set((state) =>
      state.visible && state.taskId === taskId
        ? { phase: "ready" }
        : state,
    ),
  hide: () =>
    set({ visible: false, phase: "closed", taskId: null }),
}));
