import { create } from "zustand";
import { persist } from "zustand/middleware";

/** RD9: null until the first-run setup is finished or skipped; it is never offered again after that. */
export type FirstRunSetupState = "done" | "skipped" | null;

interface SetupStoreState {
  setupState: FirstRunSetupState;
  setSetupState: (setupState: Exclude<FirstRunSetupState, null>) => void;
}

export function normalizeFirstRunSetupState(value: unknown): FirstRunSetupState {
  return value === "done" || value === "skipped" ? value : null;
}

export const useSetupStore = create<SetupStoreState>()(
  persist(
    (set) => ({
      setupState: null,
      setSetupState: (setupState) => set({ setupState }),
    }),
    {
      name: "norea-first-run-setup",
      partialize: (state) => ({ setupState: state.setupState }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        setupState: normalizeFirstRunSetupState(
          (persistedState as Partial<SetupStoreState> | null)?.setupState,
        ),
      }),
    },
  ),
);
