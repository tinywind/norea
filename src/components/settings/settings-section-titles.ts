import type { TranslationKey } from "../../i18n";
import type { SettingsSectionId } from "../../lib/use-settings-section";

export const SETTINGS_SECTION_TITLE_KEYS: Record<SettingsSectionId, TranslationKey> = {
  appearance: "settings.category.appearance.title",
  general: "settings.category.general.title",
  reader: "settings.category.reader.title",
  library: "settings.category.library.title",
  downloads: "settings.category.downloads.title",
  backup: "settings.category.backup.title",
  network: "settings.category.network.title",
  reset: "settings.category.reset.title",
  about: "settings.category.about.title",
  developer: "settings.category.developer.title",
};
