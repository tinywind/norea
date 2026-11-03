import type { PluginItem } from "./plugins/types";
import type { FirstRunSetupState } from "../store/setup";

export interface FirstRunSetupCheck {
  pathname: string;
  pluginCount: number;
  repositoryCount: number;
  setupState: FirstRunSetupState;
}

/**
 * RD9 opens /setup once: on a launch into the Library, before the user has
 * finished or skipped it, while no repository and no plugin exist.
 */
export function shouldOpenFirstRunSetup({
  pathname,
  pluginCount,
  repositoryCount,
  setupState,
}: FirstRunSetupCheck): boolean {
  return setupState === null && pathname === "/" && repositoryCount === 0 && pluginCount === 0;
}

/** Plugins the setup can install in one step; multi-source templates need their own form. */
export function setupInstallableItems(items: readonly PluginItem[]): PluginItem[] {
  return items.filter((item) => item.installMode !== "multiSource");
}

/** The repository's languages, with the app language first when it has sources. */
export function setupLanguages(items: readonly PluginItem[], appLocale: string): string[] {
  const languages = [...new Set(setupInstallableItems(items).map((item) => item.lang).filter(Boolean))].sort();
  return languages.includes(appLocale)
    ? [appLocale, ...languages.filter((lang) => lang !== appLocale)]
    : languages;
}

/** The app language starts selected when the repository has sources in it. */
export function initialSetupLanguages(items: readonly PluginItem[], appLocale: string): string[] {
  return setupLanguages(items, appLocale).includes(appLocale) ? [appLocale] : [];
}

/** Suggested sources: every one-step plugin in the chosen languages, by name. */
export function suggestedSetupSources(items: readonly PluginItem[], languages: readonly string[]): PluginItem[] {
  return setupInstallableItems(items)
    .filter((item) => languages.includes(item.lang))
    .sort((left, right) => left.name.localeCompare(right.name));
}
