import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Group, Loader, Stack, Text } from "@mantine/core";
import {
  convertLocalCoverFile,
  isLocalCoverSource,
  LOCAL_COVER_ACCEPT,
  LOCAL_COVER_LIMITS,
  LocalCoverError,
} from "../lib/local-cover";
import { useTranslation } from "../i18n";
import { ConsoleCover } from "./ConsolePrimitives";
import { IconButton } from "./IconButton";
import { ImageIcon, TrashIcon } from "./ui/icons";

interface LocalCoverPickerProps {
  alt: string;
  disabled?: boolean;
  onChange: (cover: string) => void;
  /** Reports whether a chosen image is still being converted. */
  onPendingChange?: (pending: boolean) => void;
  value: string | null | undefined;
}

export function LocalCoverPicker({
  alt,
  disabled = false,
  onChange,
  onPendingChange,
  value,
}: LocalCoverPickerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const coverSource: string | null = isLocalCoverSource(value) ? value : null;
  const maxMegabytes = LOCAL_COVER_LIMITS.fileBytes / (1024 * 1024);

  useEffect(() => () => {
    requestRef.current += 1;
  }, []);

  const setConverting = (converting: boolean) => {
    setPending(converting);
    onPendingChange?.(converting);
  };

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;

    // Only the latest choice may set the cover; an earlier, slower conversion is dropped.
    const request = ++requestRef.current;
    setError(null);
    setConverting(true);
    try {
      const cover = await convertLocalCoverFile(file);
      if (request === requestRef.current) onChange(cover);
    } catch (caught) {
      if (request === requestRef.current) {
        setError(localCoverErrorMessage(caught, maxMegabytes, t));
      }
    } finally {
      if (request === requestRef.current) setConverting(false);
    }
  };

  return (
    <Stack gap={4}>
      <Text fw="var(--norea-weight-medium)" size="sm">
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
            <IconButton
              disabled={disabled}
              label={t("library.localNovel.coverChoose")}
              onClick={() => inputRef.current?.click()}
              size="lg"
              type="button"
            >
              <ImageIcon />
            </IconButton>
            <IconButton
              disabled={disabled || (!coverSource && !pending)}
              label={t("library.localNovel.coverClear")}
              onClick={() => {
                requestRef.current += 1;
                setConverting(false);
                setError(null);
                onChange("");
              }}
              size="lg"
              tone="danger"
              type="button"
            >
              <TrashIcon />
            </IconButton>
          </Group>
          {pending ? (
            <Group gap="xs" role="status">
              <Loader size="xs" />
              <Text size="xs">{t("library.localNovel.coverConverting")}</Text>
            </Group>
          ) : (
            <Text c="dimmed" size="xs">
              {t("library.localNovel.coverHelp", { size: maxMegabytes })}
            </Text>
          )}
        </Stack>
      </Group>
      {error ? (
        <Text c="danger" role="alert" size="sm">
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
