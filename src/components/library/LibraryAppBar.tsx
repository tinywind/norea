import { ActionIcon, Loader, TextInput } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { PageHeader } from "../AppFrame";
import { IconButton } from "../IconButton";
import {
  CategoryIcon,
  CloseIcon,
  RefreshIcon,
  SearchIcon,
  ViewOptionsIcon,
} from "../ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "../ui/OverflowMenu";

interface LibraryAppBarProps {
  /** Category tabs for the bar's leading slot; null where a side list shows them. */
  categoryTabs?: ReactNode;
  /** Shows the inline search field in place of the search icon. */
  wide: boolean;
  onManageCategories: () => void;
  onOpenViewOptions: () => void;
  onRefresh: () => void;
  onSearchChange: (search: string) => void;
  overflowItems: readonly OverflowMenuItem[];
  refreshDisabled: boolean;
  refreshing: boolean;
  search: string;
}

export function LibraryAppBar({
  categoryTabs = null,
  wide,
  onManageCategories,
  onOpenViewOptions,
  onRefresh,
  onSearchChange,
  overflowItems,
  refreshDisabled,
  refreshing,
  search,
}: LibraryAppBarProps) {
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(search !== "");
  const closeSearch = () => {
    onSearchChange("");
    setSearchOpen(false);
  };

  useOverlayBackNavigation(!wide && searchOpen, closeSearch);

  if (!wide && searchOpen) {
    return (
      <PageHeader
        backLabel={t("library.search.close")}
        onBack={closeSearch}
        title={t("nav.library")}
      >
        <LibrarySearchField autoFocus onChange={onSearchChange} value={search} />
      </PageHeader>
    );
  }

  const searchField = wide ? (
    <LibrarySearchField onChange={onSearchChange} value={search} />
  ) : null;

  const manageCategories = (
    <IconButton label={t("library.manageCategories")} onClick={onManageCategories} size="lg">
      <CategoryIcon />
    </IconButton>
  );

  return (
    <PageHeader
      actions={
        <>
          {wide ? (categoryTabs ? searchField : null) : (
            <IconButton
              label={t("library.search.aria")}
              onClick={() => setSearchOpen(true)}
              size="lg"
            >
              <SearchIcon />
            </IconButton>
          )}
          <IconButton
            disabled={refreshDisabled || refreshing}
            label={t("library.refresh")}
            onClick={onRefresh}
            size="lg"
          >
            {refreshing ? <Loader size="sm" /> : <RefreshIcon />}
          </IconButton>
          <IconButton
            aria-haspopup="dialog"
            label={t("library.viewOptions.display")}
            onClick={onOpenViewOptions}
            size="lg"
          >
            <ViewOptionsIcon />
          </IconButton>
          <OverflowMenu items={overflowItems} label={t("common.more")} />
        </>
      }
      className="norea-library-app-bar"
      title={t("nav.library")}
      titleHidden
    >
      {wide && !categoryTabs ? (
        <div className="norea-library-category-heading"><span aria-hidden="true">{t("nav.library")}</span>{manageCategories}</div>
      ) : null}
      {categoryTabs ?? searchField}
      {categoryTabs ? manageCategories : null}
    </PageHeader>
  );
}

function LibrarySearchField({
  autoFocus,
  onChange,
  value,
}: {
  autoFocus?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  const { t } = useTranslation();

  return (
    <TextInput
      aria-label={t("library.search.aria")}
      autoFocus={autoFocus}
      className="norea-library-search"
      leftSection={<SearchIcon size="1.125rem" />}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={t("library.search.placeholder")}
      rightSection={
        value ? (
          <ActionIcon
            aria-label={t("searchBar.clear")}
            onClick={() => onChange("")}
            variant="subtle"
          >
            <CloseIcon size="1.125rem" />
          </ActionIcon>
        ) : null
      }
      value={value}
    />
  );
}
