import { create } from "zustand";
import { persist } from "zustand/middleware";

function defaultWebviewUserAgent(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

function normalizeUserAgent(userAgent: string): string {
  const trimmed = userAgent.trim();
  return trimmed === "" ? defaultWebviewUserAgent() : trimmed;
}

export const DEFAULT_USER_AGENT = defaultWebviewUserAgent();

interface UserAgentState {
  userAgent: string;
  setUserAgent: (userAgent: string) => void;
  resetUserAgent: () => string;
}

export const useUserAgentStore = create<UserAgentState>()(
  persist(
    (set) => ({
      userAgent: DEFAULT_USER_AGENT,
      setUserAgent: (userAgent) =>
        set({
          userAgent: normalizeUserAgent(userAgent),
        }),
      resetUserAgent: () => {
        const userAgent = defaultWebviewUserAgent();
        set({ userAgent });
        return userAgent;
      },
    }),
    {
      name: "http-user-agent",
      version: 1,
    },
  ),
);

export function getScraperUserAgent(): string | null {
  return useUserAgentStore.getState().userAgent.trim() || null;
}
