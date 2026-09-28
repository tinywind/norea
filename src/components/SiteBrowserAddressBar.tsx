import { useState, type FormEvent } from "react";
import { Button, Group, TextInput } from "@mantine/core";
import { useTranslation } from "../i18n";

interface SiteBrowserAddressBarProps {
  url: string;
  loading: boolean;
  onNavigate: (url: string) => void;
}

export function SiteBrowserAddressBar({
  url,
  loading,
  onNavigate,
}: SiteBrowserAddressBarProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    let address: URL;
    try {
      address = new URL((draft ?? url).trim());
      if (
        !["http:", "https:"].includes(address.protocol) ||
        address.username ||
        address.password
      ) {
        throw new Error("Invalid browser address");
      }
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    event.currentTarget.querySelector("input")?.blur();
    onNavigate(address.href);
  };

  return (
    <form noValidate onSubmit={submit} style={{ flexShrink: 0 }}>
      <Group px="md" py="xs" gap="xs" wrap="nowrap" align="flex-start">
        <TextInput
          aria-label={t("siteBrowser.address")}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="go"
          error={invalid ? t("siteBrowser.invalidAddress") : undefined}
          inputMode="url"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(null);
              setInvalid(false);
              event.currentTarget.blur();
            }
          }}
          spellCheck={false}
          style={{ flex: 1, minWidth: 0 }}
          type="url"
          value={draft ?? url}
        />
        <Button disabled={loading} type="submit" variant="default">
          {t("siteBrowser.go")}
        </Button>
      </Group>
    </form>
  );
}
