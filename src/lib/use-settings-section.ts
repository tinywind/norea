import { useCallback } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { goBackInAppHistory } from "./navigation-history";

/** Settings sections in display order. */
export const SETTINGS_SECTION_IDS = [
  "appearance",
  "general",
  "reader",
  "library",
  "downloads",
  "backup",
  "browse",
  "network",
  "reset",
  "about",
  "developer",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Section ids used by earlier builds and links, mapped to their new home. */
const RENAMED_SETTINGS_SECTIONS: Readonly<Record<string, SettingsSectionId>> = {
  app: "appearance",
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
 *
 * With `stacked`, as on phones where a section replaces the index, opening a
 * section adds a history entry and closing it goes back to the page it was
 * opened from: the index, or another page such as More. A section with no
 * earlier in-app entry closes to the index. Without `stacked`, selections
 * replace the current entry so switching sections does not grow history.
 */
export function useSettingsSection(
  section: string | undefined,
  stacked: boolean,
): readonly [
  SettingsSectionId | null,
  (id: SettingsSectionId) => void,
  () => void,
] {
  const navigate = useNavigate();
  const router = useRouter();
  const selectSection = useCallback(
    (id: SettingsSectionId) => {
      void navigate({
        to: "/settings",
        search: { section: id },
        replace: !stacked,
      });
    },
    [navigate, stacked],
  );
  const closeSection = useCallback(() => {
    if (goBackInAppHistory(router.state.location.href)) return;
    void navigate({
      to: "/settings",
      search: { section: undefined },
      replace: true,
    });
  }, [navigate, router]);
  return [normalizeSettingsSection(section), selectSection, closeSection] as const;
}
