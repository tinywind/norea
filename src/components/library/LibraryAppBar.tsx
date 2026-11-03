import { ActionIcon, Button, Loader, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "../../i18n";
import { IconButton } from "../IconButton";
import {
  BackIcon,
  CloseIcon,
  RefreshIcon,
  SearchIcon,
  ViewOptionsIcon,
} from "../ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "../ui/OverflowMenu";

interface LibraryAppBarProps {
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

  if (!wide && searchOpen) {
    return (
      <header className="norea-library-app-bar" data-searching="true">
        <IconButton label={t("library.search.close")} onClick={closeSearch} size="lg">
          <BackIcon />
        </IconButton>
        <LibrarySearchField autoFocus onChange={onSearchChange} value={search} />
      </header>
    );
  }

  return (
    <header className="norea-library-app-bar">
      <h1 className="norea-library-app-bar-title">{t("nav.library")}</h1>
      {wide ? (
        <LibrarySearchField onChange={onSearchChange} value={search} />
      ) : (
        <IconButton
          label={t("library.search.aria")}
          onClick={() => setSearchOpen(true)}
          size="lg"
        >
          <SearchIcon />
        </IconButton>
      )}
      {wide ? (
        <>
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
            variant="default"
          >
            {t("library.viewOptions.short")}
          </Button>
        </>
      ) : (
        <IconButton
          label={t("library.viewOptions.title")}
          onClick={onOpenViewOptions}
          size="lg"
        >
          <ViewOptionsIcon />
        </IconButton>
      )}
      <OverflowMenu items={overflowItems} label={t("common.more")} />
    </header>
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
