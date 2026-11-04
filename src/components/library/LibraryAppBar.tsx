import { ActionIcon, Button, Loader, TextInput } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { PageHeader } from "../AppFrame";
import { IconButton } from "../IconButton";
import {
  CloseIcon,
  RefreshIcon,
  SearchIcon,
  ViewOptionsIcon,
} from "../ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "../ui/OverflowMenu";

interface LibraryAppBarProps {
  /** Category tabs for the bar's leading slot; null where a side list shows them. */
  categoryTabs?: ReactNode;
  /** Shows the inline search field and the labeled actions. */
  wide: boolean;
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

  return (
    <PageHeader
      actions={
        <>
          {wide ? (
            <>
              {categoryTabs ? searchField : null}
              <IconButton
                disabled={refreshDisabled || refreshing}
                label={t("library.refresh")}
                onClick={onRefresh}
                size="lg"
              >
                {refreshing ? <Loader size="sm" /> : <RefreshIcon />}
              </IconButton>
              <Button
                leftSection={<ViewOptionsIcon size="1.125rem" />}
                onClick={onOpenViewOptions}
                variant="subtle"
              >
                {t("library.viewOptions.short")}
              </Button>
            </>
          ) : (
            <>
              <IconButton
                label={t("library.search.aria")}
                onClick={() => setSearchOpen(true)}
                size="lg"
              >
                <SearchIcon />
              </IconButton>
              <IconButton
                label={t("library.viewOptions.title")}
                onClick={onOpenViewOptions}
                size="lg"
              >
                <ViewOptionsIcon />
              </IconButton>
            </>
          )}
          <OverflowMenu items={overflowItems} label={t("common.more")} />
        </>
      }
      title={t("nav.library")}
      titleHidden
    >
      {categoryTabs ?? searchField}
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
