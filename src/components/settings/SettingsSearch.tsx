import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useTranslation } from "../../i18n";
import { prefersReducedMotion } from "../../theme/motion";
import type { SettingsSectionId } from "../../lib/use-settings-section";
import { StateView } from "../AppFrame";
import { SearchBar } from "../SearchBar";
import { ListRow } from "../ui/ListRow";
import { searchSettings, type SettingsSearchResult } from "./settings-search-index";
import { settingsRowSelector, useSettingsRevealStore } from "./settings-reveal";

const SEARCH_HIT_MS = 2_000;
/** Covers the Advanced group's expand transition before the second scroll. */
const ADVANCED_EXPAND_SETTLE_MS = 300;

interface SettingsSearchProps {
  onQueryChange: (query: string) => void;
  onSelect: (result: SettingsSearchResult) => void;
  query: string;
}

/** RD18: the settings search field and, while it has text, its results instead of the section list. */
export function SettingsSearch({ onQueryChange, onSelect, query }: SettingsSearchProps) {
  const { t } = useTranslation();
  const results = useMemo(() => searchSettings(query, t), [query, t]);
  const trimmed = query.trim();

  return (
    <div className="norea-settings-search">
      <SearchBar onChange={onQueryChange} placeholder={t("settingsSearch.placeholder")} value={query} />
      {trimmed === "" ? null : results.length === 0 ? (
        <StateView title={t("settingsSearch.noResults", { query: trimmed })} />
      ) : (
        <ul aria-label={t("settingsSearch.results", { query: trimmed })} className="norea-settings-index-list">
          {results.map((result) => (
            <li key={result.row.label}>
              <ListRow
                className="norea-settings-index-row"
                onClick={() => onSelect(result)}
                subtitle={result.notes.length > 0 ? result.notes.join(" · ") : undefined}
                title={result.title}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Selecting a result: open its section and ask the row to show itself. */
export function openSettingsSearchResult(
  result: SettingsSearchResult,
  selectSection: (id: SettingsSectionId) => void,
): void {
  selectSection(result.row.section);
  useSettingsRevealStore.getState().reveal(result.row.section, result.label);
}

/** Scrolls a revealed row of the shown section into view and marks it briefly. */
export function useSettingsRevealScroll(
  bodyRef: RefObject<HTMLElement | null>,
  sectionId: SettingsSectionId,
): void {
  const target = useSettingsRevealStore((state) => state.target);
  const handledToken = useRef(0);

  useEffect(() => {
    const body = bodyRef.current;
    if (!target || !body || target.section !== sectionId || handledToken.current === target.token) return;
    const timers: number[] = [];
    let hitRow: HTMLElement | null = null;
    const show = () => {
      const row = body.querySelector<HTMLElement>(settingsRowSelector(target.label));
      if (!row) return null;
      row.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
      return row;
    };
    const frame = window.requestAnimationFrame(() => {
      const row = show();
      if (!row) return;
      handledToken.current = target.token;
      hitRow = row;
      row.dataset.searchHit = "true";
      timers.push(window.setTimeout(() => delete row.dataset.searchHit, SEARCH_HIT_MS));
      if (row.closest('.norea-settings-advanced[data-expanded="false"]') || row.offsetParent === null) {
        timers.push(window.setTimeout(show, ADVANCED_EXPAND_SETTLE_MS));
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
      if (hitRow) delete hitRow.dataset.searchHit;
    };
  }, [bodyRef, sectionId, target]);
}
