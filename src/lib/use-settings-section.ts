import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";

/** Settings sections in display order. */
export const SETTINGS_SECTION_IDS = [
  "appearance",
  "general",
  "reader",
  "library",
  "downloads",
  "backup",
  "network",
  "reset",
  "about",
  "developer",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Section ids used by earlier builds and links, mapped to their new home. */
const RENAMED_SETTINGS_SECTIONS: Readonly<Record<string, SettingsSectionId>> = {
  app: "appearance",
  browse: "downloads",
  data: "backup",
};

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

/** Returns the section a `?section=` value opens, or null for the section index. */
export function normalizeSettingsSection(
  section: string | undefined,
): SettingsSectionId | null {
  const id = section?.trim().toLowerCase();
  if (!id) return null;
  if (isSettingsSectionId(id)) return id;
  return RENAMED_SETTINGS_SECTIONS[id] ?? null;
}

/**
 * Reads the active settings section from the route search and writes
 * selections back to it, so a later navigation to any section always applies.
 * Selecting null returns to the section index.
 */
export function useSettingsSection(
  section: string | undefined,
): readonly [SettingsSectionId | null, (id: SettingsSectionId | null) => void] {
  const navigate = useNavigate();
  const selectSection = useCallback(
    (id: SettingsSectionId | null) => {
      void navigate({
        to: "/settings",
        search: { section: id ?? undefined },
        replace: true,
      });
    },
    [navigate],
  );
  return [normalizeSettingsSection(section), selectSection] as const;
}
