import { create } from "zustand";
import type { SourceAccessChallenge } from "../lib/plugins/source-access";

export type SiteBrowserPhase = "closed" | "queued" | "loading" | "ready";
export type SiteBrowserOutcome = "keep-paused" | "verify";

export type SiteBrowserContext =
  | { mode: "browse" }
  | {
      mode: "source-access";
      challenge: SourceAccessChallenge;
      revision: number;
      scopeKey: string;
      sourceName: string;
    };

export interface SiteBrowserCompletion {
  outcome: SiteBrowserOutcome;
  revision: number;
  scopeKey: string;
  taskId: string;
}

interface SiteBrowserState {
  /** Whether the in-app site browser overlay is currently shown. */
  visible: boolean;
  /** The URL the scraper Webview should be navigated to on open. */
  currentUrl: string | null;
  /** Source whose isolated browser profile owns the current request. */
  sourceId: string | null;
  /** Scheduler task that owns the current browser request. */
  taskId: string | null;
  /** Whether the request is queued, navigating, ready, or closed. */
  phase: SiteBrowserPhase;
  /** Monotonic sequence for repeated open requests, including the same URL. */
  openSequence: number;
  /** The interaction represented by the current browser request. */
  context: SiteBrowserContext | null;
  /** The most recent task-owned browser result. */
  completion: SiteBrowserCompletion | null;
  /** Show blocking browser chrome while the scheduler request is queued. */
  queueAt: (
    sourceId: string,
    url: string,
    taskId: string,
    context?: SiteBrowserContext,
  ) => void;
  /** Start native navigation after the scheduler assigns the executor. */
  startLoading: (sourceId: string, url: string, taskId: string) => void;
  /** Mark the current native page as ready for interaction. */
  markReady: (taskId: string) => void;
  /** Complete the browser request only when the owning task still matches. */
  complete: (
    taskId: string,
    revision: number,
    outcome: SiteBrowserOutcome,
  ) => boolean;
  /** Hide the overlay. The scraper Webview is collapsed but kept alive. */
  hide: () => void;
}

export const useSiteBrowserStore = create<SiteBrowserState>((set) => ({
  visible: false,
  currentUrl: null,
  sourceId: null,
  taskId: null,
  phase: "closed",
  openSequence: 0,
  context: null,
  completion: null,
  queueAt: (sourceId, url, taskId, context = { mode: "browse" }) =>
    set({
      visible: true,
      currentUrl: url,
      sourceId,
      taskId,
      phase: "queued",
      context,
      completion: null,
    }),
  startLoading: (sourceId, url, taskId) =>
    set((state) =>
      state.visible &&
      state.sourceId === sourceId &&
      state.currentUrl === url &&
      state.taskId === taskId
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
  complete: (taskId, revision, outcome) => {
    let completed = false;
    set((state) => {
      const context = state.context;
      if (
        !state.visible ||
        state.taskId !== taskId ||
        context?.mode !== "source-access" ||
        context.revision !== revision ||
        (outcome === "verify" && state.phase !== "ready")
      ) {
        return state;
      }
      completed = true;
      return {
        completion: {
          outcome,
          revision,
          scopeKey: context.scopeKey,
          taskId,
        },
        context: null,
        phase: "closed",
        sourceId: null,
        taskId: null,
        visible: false,
      };
    });
    return completed;
  },
  hide: () =>
    set({
      completion: null,
      context: null,
      visible: false,
      phase: "closed",
      sourceId: null,
      taskId: null,
    }),
}));
