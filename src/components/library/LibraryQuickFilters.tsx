import { Button } from "@mantine/core";
import type { LibraryNovelSummary } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { CheckIcon, FilterIcon } from "../ui/icons";
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
          <Button
            aria-pressed={flag.active}
            className="norea-library-chip"
            key={flag.id}
            leftSection={flag.active ? <CheckIcon size="1rem" /> : undefined}
            onClick={() => flag.set(!flag.active)}
            radius="xl"
            size="compact-sm"
            variant={flag.active ? "light" : "default"}
          >
            {t(flag.labelKey)}
          </Button>
        ))}
      <Button
        className="norea-library-chip"
        leftSection={<FilterIcon size="1rem" />}
        onClick={onOpenFilters}
        radius="xl"
        size="compact-sm"
        variant={activeCount > 0 ? "light" : "default"}
      >
        {activeCount > 0
          ? t("library.filter.moreActive", { count: activeCount })
          : t("library.filter.more")}
      </Button>
      {activeCount > 0 ? (
        <Button
          className="norea-library-chip"
          onClick={onClear}
          radius="xl"
          size="compact-sm"
          variant="subtle"
        >
          {t("common.clear")}
        </Button>
      ) : null}
    </div>
  );
}
