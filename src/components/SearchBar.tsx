import { Group, TextInput } from "@mantine/core";
import { CloseGlyph, SearchGlyph } from "./ActionGlyphs";
import { IconButton } from "./IconButton";
import { useTranslation } from "../i18n";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Optional explicit submit handler. When set, the search input
   * stops debouncing and instead a search icon button (and the Enter
   * key) trigger this callback.
   */
  onSubmit?: () => void;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  placeholder,
}: SearchBarProps) {
  const { t } = useTranslation();
  const input = (
    <TextInput
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={
        onSubmit
          ? (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmit();
              }
            }
          : undefined
      }
      placeholder={placeholder ?? t("searchBar.defaultPlaceholder")}
      size="sm"
      classNames={{
        input: "norea-search-field-input",
        root: "norea-search-field",
      }}
      style={{ flex: 1, minWidth: 0 }}
      rightSectionWidth={40}
      rightSection={
        value.length > 0 ? (
          <IconButton
            className="norea-search-clear-button"
            label={t("searchBar.clear")}
            size="sm"
            onClick={() => onChange("")}
          >
            <CloseGlyph />
          </IconButton>
        ) : null
      }
    />
  );

  if (!onSubmit) return input;

  return (
    <Group
      className="norea-search-bar"
      gap="xs"
      wrap="nowrap"
      style={{ flex: 1, minWidth: 0, width: "100%" }}
    >
      {input}
      <IconButton
        className="norea-search-submit-button"
        label={t("common.search")}
        size="lg"
        onClick={onSubmit}
      >
        <SearchGlyph />
      </IconButton>
    </Group>
  );
}
