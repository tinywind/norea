import { ListRow } from "../ui/ListRow";
import { ChevronRightIcon } from "../ui/icons";
import type { SettingsSectionId } from "../../lib/use-settings-section";
import { useTranslation } from "../../i18n";
import { useSettingsSummaries } from "./settings-summaries";

export interface SettingsIndexEntry {
  id: SettingsSectionId;
  title: string;
}

interface SettingsIndexProps {
  /** The section shown beside the index; omitted when the index is the page. */
  activeId?: SettingsSectionId;
  entries: readonly SettingsIndexEntry[];
  onSelect: (id: SettingsSectionId) => void;
}

/** The settings section list, each row with a one-line current-state summary. */
export function SettingsIndex({ activeId, entries, onSelect }: SettingsIndexProps) {
  const { t } = useTranslation();
  const summaries = useSettingsSummaries();

  return (
    <nav className="norea-settings-index" aria-label={t("settings.title")}>
      <ul className="norea-settings-index-list">
        {entries.map((entry) => {
          const selected = entry.id === activeId;
          return (
            <li key={entry.id}>
              <ListRow
                aria-current={selected ? "page" : undefined}
                className="norea-settings-index-row"
                data-section={entry.id}
                onClick={() => onSelect(entry.id)}
                selected={selected}
                subtitle={summaries[entry.id]}
                title={entry.title}
                trailing={
                  activeId === undefined ? (
                    <ChevronRightIcon className="norea-settings-index-chevron" />
                  ) : null
                }
              />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
