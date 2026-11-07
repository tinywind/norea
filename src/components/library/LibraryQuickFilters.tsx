import type { LibraryNovelSummary } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { ChipButton } from "../ChipButton";
import { IconButton } from "../IconButton";
import { FilterIcon, SelectIcon } from "../ui/icons";
import { useLibraryFilterFlags } from "./LibraryViewOptions";

interface LibraryQuickFiltersProps {
  counts: LibraryNovelSummary;
  onClear: () => void;
  onOpenFilters: () => void;
  onToggleSelection?: () => void;
  selectionActive?: boolean;
  selectionDisabled?: boolean;
  sourceActive: boolean;
}

/**
 * One-tap Unread and Downloaded filters, the entry to every other filter, and
 * Clear. Filters persist across restarts, so the active count stays visible.
 */
export function LibraryQuickFilters({
  counts,
  onClear,
  onOpenFilters,
  onToggleSelection,
  selectionActive = false,
  selectionDisabled = false,
  sourceActive,
}: LibraryQuickFiltersProps) {
  const { t } = useTranslation();
  const flags = useLibraryFilterFlags(counts);
  const activeCount =
    flags.filter((flag) => flag.active).length + (sourceActive ? 1 : 0);

  return (
    <div className="norea-library-filter-row">
      <div
        aria-label={t("library.filters.label")}
        className="norea-library-chips"
        role="group"
      >
        {flags
          .filter((flag) => flag.id === "unread" || flag.id === "downloaded")
          .map((flag) => (
            <ChipButton
              className="norea-library-chip"
              key={flag.id}
              onClick={() => flag.set(!flag.active)}
              selected={flag.active}
            >
              {t(flag.labelKey)}
            </ChipButton>
          ))}
        <ChipButton
          className="norea-library-chip"
          icon={<FilterIcon />}
          onClick={onOpenFilters}
          tone={activeCount > 0 ? "accent" : undefined}
        >
          {activeCount > 0
            ? t("library.filter.moreActive", { count: activeCount })
            : t("library.filter.more")}
        </ChipButton>
        {activeCount > 0 ? (
          <ChipButton className="norea-library-chip" onClick={onClear}>
            {t("common.clear")}
          </ChipButton>
        ) : null}
      </div>
      {onToggleSelection ? (
        <IconButton
          active={selectionActive}
          aria-pressed={selectionActive}
          disabled={selectionDisabled}
          label={t(selectionActive ? "selection.exit" : "library.selection.start")}
          onClick={onToggleSelection}
          size="lg"
        >
          <SelectIcon />
        </IconButton>
      ) : null}
    </div>
  );
}
