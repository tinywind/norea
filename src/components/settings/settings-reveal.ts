import { create } from "zustand";
import type { SettingsSectionId } from "../../lib/use-settings-section";

interface SettingsRevealState {
  /** The label of the row a search result asked to show; `token` repeats a reveal of the same row. */
  target: { label: string; section: SettingsSectionId; token: number } | null;
  reveal: (section: SettingsSectionId, label: string) => void;
}

let nextToken = 0;

/** A settings search result asks its row to open any Advanced group around it and scroll into view. */
export const useSettingsRevealStore = create<SettingsRevealState>((set) => ({
  target: null,
  reveal: (section, label) => set({ target: { label, section, token: ++nextToken } }),
}));

export function settingsRowSelector(label: string): string {
  return `[data-settings-label="${label.replace(/["\\]/g, "\\$&")}"]`;
}
