import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";

export type SettingsCategoryId =
  | "app"
  | "reader"
  | "library"
  | "browse"
  | "data"
  | "about";

function normalizeSettingsSection(
  section: string | undefined,
): SettingsCategoryId {
  switch (section?.toLowerCase()) {
    case "reader":
      return "reader";
    case "library":
      return "library";
    case "browse":
      return "browse";
    case "data":
      return "data";
    case "about":
      return "about";
    case "app":
    default:
      return "app";
  }
}

/**
 * Reads the active settings section from the route search and writes
 * selections back to it, so a later navigation to any section always applies.
 */
export function useSettingsSection(
  section: string | undefined,
): readonly [SettingsCategoryId, (id: SettingsCategoryId) => void] {
  const navigate = useNavigate();
  const selectSection = useCallback(
    (id: SettingsCategoryId) => {
      void navigate({ to: "/settings", search: { section: id }, replace: true });
    },
    [navigate],
  );
  return [normalizeSettingsSection(section), selectSection] as const;
}
