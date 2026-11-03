import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UpdatesSeenStore {
  /** Unix seconds when the user last looked at Updates; newer found chapters raise the nav badge. */
  updatesSeenAt: number;
  markUpdatesSeen: (nowSeconds?: number) => void;
}

export const UPDATES_SEEN_KEY = "updates-seen";

export const useUpdatesSeenStore = create<UpdatesSeenStore>()(persist(
  (set) => ({
    updatesSeenAt: 0,
    markUpdatesSeen: (nowSeconds = Math.floor(Date.now() / 1000)) =>
      set((state) => (nowSeconds > state.updatesSeenAt ? { updatesSeenAt: nowSeconds } : state)),
  }),
  {
    name: UPDATES_SEEN_KEY,
    partialize: ({ updatesSeenAt }) => ({ updatesSeenAt }),
    merge: (persisted, current) => {
      const value = (persisted as { updatesSeenAt?: unknown } | null)?.updatesSeenAt;
      return { ...current, updatesSeenAt: Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0 };
    },
  },
));
