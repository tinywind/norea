import { Button } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../../i18n";
import { StateView } from "../AppFrame";
import { SearchIcon } from "../ui/icons";

interface LibrarySearchSourcesProps {
  /** The search matched no library novel, so the hand-off is the main content. */
  empty: boolean;
  onClearFilters: () => void;
  query: string;
}

/**
 * RD10: continues a library title search in Browse > Search, which runs the
 * query once. The library keeps its query, category and scroll for Back.
 */
export function LibrarySearchSources({ empty, onClearFilters, query }: LibrarySearchSourcesProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const label = t("library.searchSources", { query });
  const searchSources = () => {
    void navigate({ to: "/browse", search: { q: query, tab: "search" } });
  };

  if (empty) {
    return (
      <div className="norea-library-state">
        <StateView
          action={{ label, onClick: searchSources }}
          message={t("library.noMatches.message")}
          secondaryAction={{ label: t("library.noMatches.clear"), onClick: onClearFilters }}
          title={t("common.noMatches")}
        />
      </div>
    );
  }

  return (
    <div className="norea-library-search-sources">
      <Button
        leftSection={<SearchIcon aria-hidden="true" size="1.125rem" />}
        onClick={searchSources}
        variant="subtle"
      >
        {label}
      </Button>
    </div>
  );
}
