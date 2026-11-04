import type { LibraryNovelSummary } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { ChipButton } from "../ChipButton";
import { FilterIcon } from "../ui/icons";
import { useLibraryFilterFlags } from "./LibraryViewOptions";

interface LibraryQuickFiltersProps {
  counts: LibraryNovelSummary;
  onClear: () => void;
  onOpenFilters: () => void;
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
  sourceActive,
}: LibraryQuickFiltersProps) {
  const { t } = useTranslation();
  const flags = useLibraryFilterFlags(counts);
  const activeCount =
    flags.filter((flag) => flag.active).length + (sourceActive ? 1 : 0);

  return (
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
  );
}
