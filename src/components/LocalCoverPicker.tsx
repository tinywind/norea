import { useRef, useState, type ChangeEvent } from "react";
import { Group, Stack, Text } from "@mantine/core";
import {
  convertLocalCoverFile,
  isLocalCoverSource,
  LOCAL_COVER_ACCEPT,
  LOCAL_COVER_LIMITS,
  LocalCoverError,
} from "../lib/local-cover";
import { useTranslation } from "../i18n";
import { ConsoleCover } from "./ConsolePrimitives";
import { TextButton } from "./TextButton";

interface LocalCoverPickerProps {
  alt: string;
  disabled?: boolean;
  onChange: (cover: string) => void;
  value: string | null | undefined;
}

export function LocalCoverPicker({
  alt,
  disabled = false,
  onChange,
  value,
}: LocalCoverPickerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const coverSource: string | null = isLocalCoverSource(value) ? value : null;
  const maxMegabytes = LOCAL_COVER_LIMITS.fileBytes / (1024 * 1024);

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;

    setError(null);
    try {
      onChange(await convertLocalCoverFile(file));
    } catch (caught) {
      setError(localCoverErrorMessage(caught, maxMegabytes, t));
    }
  };

  return (
    <Stack gap={4}>
      <Text fw={500} size="sm">
        {t("library.localNovel.cover")}
      </Text>
      <Group align="center" gap="sm">
        <ConsoleCover alt={alt} height={108} src={coverSource} width={72} />
        <Stack gap={6} style={{ minWidth: 0 }}>
          <input
            accept={LOCAL_COVER_ACCEPT}
            className="norea-local-cover-picker-input"
            disabled={disabled}
            onChange={handleFileSelected}
            ref={inputRef}
            type="file"
          />
          <Group gap="xs">
            <TextButton
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              {t("library.localNovel.coverChoose")}
            </TextButton>
            <TextButton
              disabled={disabled || !coverSource}
              onClick={() => {
                setError(null);
                onChange("");
              }}
              type="button"
              variant="subtle"
            >
              {t("library.localNovel.coverClear")}
            </TextButton>
          </Group>
          <Text c="dimmed" size="xs">
            {t("library.localNovel.coverHelp", { size: maxMegabytes })}
          </Text>
        </Stack>
      </Group>
      {error ? (
        <Text c="red" size="sm">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}

function localCoverErrorMessage(
  caught: unknown,
  maxMegabytes: number,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (caught instanceof LocalCoverError) {
    if (caught.code === "too-large") {
      return t("library.localNovel.coverTooLarge", { size: maxMegabytes });
    }
    if (caught.code === "unsupported") {
      return t("library.localNovel.coverUnsupported");
    }
  }
  return t("library.localNovel.coverReadFailed");
}
