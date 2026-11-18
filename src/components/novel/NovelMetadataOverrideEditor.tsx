import { Button, Group, Select, SimpleGrid, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { NovelDetailRecord } from "../../db/queries/novel";
import {
  getNovelOverride,
  updateNovelOverride,
  type NovelOverrideCoverAction,
  type WorkOverrideUpdateFields,
} from "../../db/queries/novel-override";
import { useTranslation } from "../../i18n";
import { resolvedNovelStorageDir } from "../../lib/chapter-storage-resolution";
import { bytesToBase64 } from "../../lib/base64";
import { pushWorkOverridesNow } from "../../lib/content-sync/work-overrides";
import { describeError } from "../../lib/errors";
import { pickLocalFiles } from "../../lib/local-file-picker";
import { isNovelStatus } from "../../lib/plugins/types";
import { pluginManager } from "../../lib/plugins/manager";
import {
  chapterHistoryQueryKey,
  chapterUpdatesQueryKey,
  novelLibraryQueryKey,
} from "../../lib/reader-query-invalidation";
import { useNovelCoverSource } from "../../lib/use-novel-cover-source";
import { isOverrideCoverFileName } from "../../lib/work-metadata/schema";
import { ConsoleCover } from "../ConsolePrimitives";
import { ResponsiveSheet, SheetActions } from "../ui/ResponsiveSheet";
import { StatusAlert } from "../ui/StatusAlert";
import {
  CANONICAL_NOVEL_STATUSES,
  canonicalNovelStatusLabel,
  novelKey,
  novelStatusLabel,
} from "./novel-detail-model";

const FOLLOW_SOURCE_STATUS_VALUE = "__follow_source__";
const COVER_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"];
const MIME_TO_EXTENSION: Record<string, string> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};
const EXTENSION_TO_MIME: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};
const COVER_MAX_BYTES = 10 * 1024 * 1024;
const COVER_MAX_MB = Math.floor(COVER_MAX_BYTES / (1024 * 1024));

interface EditableTextFieldState {
  text: string;
  followSource: boolean;
}

type PendingCoverState =
  | { mode: "keep" }
  | { mode: "clear" }
  | { mode: "set"; fileName: string; bytes: Uint8Array; previewUrl: string };

interface MetadataOverrideFormState {
  name: EditableTextFieldState;
  author: EditableTextFieldState;
  artist: EditableTextFieldState;
  genres: EditableTextFieldState;
  summary: EditableTextFieldState;
  status: string | null;
  cover: PendingCoverState;
}

function initialTextFieldState(
  storedValue: unknown,
  sourceValue: string | null | undefined,
): EditableTextFieldState {
  if (typeof storedValue === "string") {
    return { text: storedValue, followSource: false };
  }
  return { text: sourceValue ?? "", followSource: true };
}

function resolveOverrideCoverFileName(file: File): string | null {
  const rawExt = file.name.split(".").pop()?.trim().toLowerCase() ?? "";
  if (rawExt) {
    const candidate = `cover.override.${rawExt}`;
    if (isOverrideCoverFileName(candidate)) return candidate;
  }
  const byMime = MIME_TO_EXTENSION[file.type.toLowerCase()];
  if (byMime) return `cover.override.${byMime}`;
  return null;
}

function overrideCoverPreviewMime(fileName: string, rawType: string): string {
  if (rawType.startsWith("image/")) return rawType;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_MIME[ext] ?? "image/png";
}

interface NovelMetadataOverrideEditorProps {
  active: boolean;
  novel: NovelDetailRecord;
  onClose: () => void;
  opened: boolean;
}

export function NovelMetadataOverrideEditor({
  active,
  novel,
  onClose,
  opened,
}: NovelMetadataOverrideEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const formId = useId();
  const visible = active && opened;

  const overrideQuery = useQuery({
    enabled: visible,
    queryKey: ["novel", "detail", novel.id, "override"] as const,
    queryFn: () => getNovelOverride(novel.id),
  });

  const sourceMetadata = novel.sourceMetadata ?? {
    name: novel.name,
    author: novel.author,
    artist: novel.artist,
    summary: novel.summary,
    status: novel.status,
    genres: novel.genres,
  };

  const buildInitialForm = useMemo(() => {
    const storedFields = overrideQuery.data?.fields ?? {};
    const statusFromOverride = typeof storedFields.status?.value === "string"
      && isNovelStatus(storedFields.status.value)
      ? storedFields.status.value
      : novel.statusOverride && isNovelStatus(novel.statusOverride)
        ? novel.statusOverride
        : null;
    return (): MetadataOverrideFormState => ({
      name: initialTextFieldState(storedFields.name?.value, sourceMetadata.name),
      author: initialTextFieldState(storedFields.author?.value, sourceMetadata.author),
      artist: initialTextFieldState(storedFields.artist?.value, sourceMetadata.artist),
      genres: initialTextFieldState(storedFields.genres?.value, sourceMetadata.genres),
      summary: initialTextFieldState(storedFields.summary?.value, sourceMetadata.summary),
      status: statusFromOverride,
      cover: { mode: "keep" },
    });
  }, [
    novel.statusOverride,
    overrideQuery.data,
    sourceMetadata.artist,
    sourceMetadata.author,
    sourceMetadata.genres,
    sourceMetadata.name,
    sourceMetadata.summary,
  ]);

  const [form, setForm] = useState<MetadataOverrideFormState>(buildInitialForm);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [pickingCover, setPickingCover] = useState(false);

  const coverPlugin = !novel.isLocal ? pluginManager.getPlugin(novel.pluginId) : null;
  const activeCoverForPreview = form.cover.mode === "clear" ? null : (novel.coverOverride ?? null);
  const storedCoverSource = useNovelCoverSource(
    {
      ...novel,
      coverOverride: activeCoverForPreview,
    },
    {
      allowSourceFallback: Boolean(coverPlugin),
      plugin: coverPlugin,
    },
  );
  const previewSrc = form.cover.mode === "set" ? form.cover.previewUrl : storedCoverSource;

  const save = useMutation({
    mutationFn: async (currentForm: MetadataOverrideFormState) => {
      const storedFields = overrideQuery.data?.fields ?? {};
      const fieldsPayload: WorkOverrideUpdateFields = {};
      const textEntries: Array<
        readonly ["name" | "author" | "artist" | "genres" | "summary", EditableTextFieldState, string | null]
      > = [
        ["name", currentForm.name, sourceMetadata.name],
        ["author", currentForm.author, sourceMetadata.author],
        ["artist", currentForm.artist, sourceMetadata.artist],
        ["genres", currentForm.genres, sourceMetadata.genres],
        ["summary", currentForm.summary, sourceMetadata.summary],
      ];
      for (const [key, entry, sourceValue] of textEntries) {
        const hadStored = typeof storedFields[key]?.value === "string";
        if (entry.followSource) {
          if (hadStored) {
            fieldsPayload[key] = null;
          }
          continue;
        }
        const value = key === "name" ? entry.text.trim() : entry.text;
        if (key === "name" && value.length === 0) {
          throw new Error(t("novel.metadataOverride.nameRequired"));
        }
        if (!hadStored && value === (sourceValue ?? "")) {
          continue;
        }
        if (storedFields[key]?.value !== value) {
          fieldsPayload[key] = value;
        }
      }

      const prevStatus = typeof storedFields.status?.value === "string"
        ? storedFields.status.value
        : novel.statusOverride;
      if (currentForm.status === null) {
        if (typeof storedFields.status?.value === "string" || novel.statusOverride !== null) {
          fieldsPayload.status = null;
        }
      } else if (prevStatus !== currentForm.status) {
        fieldsPayload.status = currentForm.status;
      }

      const coverAction: NovelOverrideCoverAction =
        currentForm.cover.mode === "set"
          ? {
              mode: "set",
              fileName: currentForm.cover.fileName,
              bytes: currentForm.cover.bytes,
            }
          : currentForm.cover;

      return updateNovelOverride(novel.id, fieldsPayload, coverAction);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: novelKey(novel.id) }),
        queryClient.invalidateQueries({ queryKey: ["novel", "detail", novel.id, "override"] }),
        queryClient.invalidateQueries({ queryKey: novelLibraryQueryKey }),
        queryClient.invalidateQueries({ queryKey: chapterUpdatesQueryKey }),
        queryClient.invalidateQueries({ queryKey: chapterHistoryQueryKey }),
      ]);
      notifications.show({ color: "green", message: t("novel.metadataOverride.saved") });
      void pushWorkOverridesNow()
        .then(() => queryClient.invalidateQueries({ queryKey: ["content-server"] }))
        .catch((error: unknown) => {
          console.warn("[content-sync] failed to push work override:", error);
        });
      onClose();
    },
  });

  const { reset: resetSave } = save;
  useEffect(() => {
    if (!visible) return;
    resetSave();
    setCoverError(null);
    setForm(buildInitialForm());
  }, [buildInitialForm, resetSave, visible]);

  const sourceStatusLabel = novelStatusLabel(sourceMetadata.status, t);
  const followSourceStatusLabel = sourceStatusLabel
    ? t("novel.metadataOverride.followSourceStatus", { status: sourceStatusLabel })
    : t("novel.metadataOverride.followSource");
  const statusOptions = [
    { value: FOLLOW_SOURCE_STATUS_VALUE, label: followSourceStatusLabel },
    ...CANONICAL_NOVEL_STATUSES.map((status) => ({
      value: status,
      label: canonicalNovelStatusLabel(status, t),
    })),
  ];

  const hasCoverOverride =
    form.cover.mode === "set" ||
    (form.cover.mode === "keep" && Boolean(novel.coverOverride));
  const coverPickerSupported = Boolean(novel.sourceNovelId) && (novel.inLibrary || Boolean(resolvedNovelStorageDir(novel.id)));

  const handleChooseCover = async () => {
    setCoverError(null);
    setPickingCover(true);
    try {
      const [file] = await pickLocalFiles({
        extensions: COVER_EXTENSIONS,
        filterName: t("library.localNovel.cover"),
        multiple: false,
        maxBytesForFile: () => COVER_MAX_BYTES,
      });
      if (!file) return;
      if (file.size > COVER_MAX_BYTES) {
        setCoverError(t("library.localNovel.coverTooLarge", { size: COVER_MAX_MB }));
        return;
      }
      const targetFileName = resolveOverrideCoverFileName(file);
      if (!targetFileName) {
        setCoverError(t("library.localNovel.coverUnsupported"));
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > COVER_MAX_BYTES) {
        setCoverError(t("library.localNovel.coverTooLarge", { size: COVER_MAX_MB }));
        return;
      }
      const mime = overrideCoverPreviewMime(targetFileName, file.type);
      const previewUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
      setForm((current) => ({
        ...current,
        cover: { mode: "set", fileName: targetFileName, bytes, previewUrl },
      }));
    } catch (error) {
      setCoverError(describeError(error) || t("library.localNovel.coverReadFailed"));
    } finally {
      setPickingCover(false);
    }
  };

  const handleFollowSourceCover = () => {
    setCoverError(null);
    setForm((current) => ({
      ...current,
      cover: novel.coverOverride ? { mode: "clear" } : { mode: "keep" },
    }));
  };

  const handleResetAllToSource = () => {
    setCoverError(null);
    setForm({
      name: { text: sourceMetadata.name, followSource: true },
      author: { text: sourceMetadata.author ?? "", followSource: true },
      artist: { text: sourceMetadata.artist ?? "", followSource: true },
      genres: { text: sourceMetadata.genres ?? "", followSource: true },
      summary: { text: sourceMetadata.summary ?? "", followSource: true },
      status: null,
      cover: novel.coverOverride ? { mode: "clear" } : { mode: "keep" },
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending || pickingCover) return;
    if (!form.name.followSource && form.name.text.trim() === "") return;
    save.mutate(form);
  };

  const renderFieldLabel = (
    labelText: string,
    followSource: boolean,
    onReset: () => void,
  ) => (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <span>{labelText}</span>
      {!followSource ? (
        <Button
          disabled={save.isPending}
          onClick={onReset}
          size="compact-xs"
          type="button"
          variant="subtle"
        >
          {t("novel.metadataOverride.followSource")}
        </Button>
      ) : null}
    </Group>
  );

  return (
    <ResponsiveSheet
      desktopVariant="modal"
      footer={
        <SheetActions>
          <Button
            disabled={save.isPending || pickingCover}
            onClick={handleResetAllToSource}
            type="button"
            variant="subtle"
          >
            {t("novel.metadataOverride.resetAll")}
          </Button>
          <Button
            disabled={save.isPending}
            onClick={onClose}
            type="button"
            variant="default"
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              pickingCover ||
              (!form.name.followSource && form.name.text.trim() === "") ||
              save.isPending
            }
            form={formId}
            loading={save.isPending}
            type="submit"
          >
            {t("common.apply")}
          </Button>
        </SheetActions>
      }
      fullScreenOnPhone
      onClose={onClose}
      opened={visible}
      size="lg"
      title={t("novel.metadataOverride.title")}
    >
      <form id={formId} onSubmit={handleSubmit}>
        <Stack gap="sm">
          <Text c="dimmed" size="sm">
            {t("novel.metadataOverride.description")}
          </Text>

          <Group align="flex-start" gap="md" wrap="nowrap">
            <ConsoleCover
              alt={form.name.text || sourceMetadata.name}
              height={96}
              src={previewSrc}
              width={64}
            />
            <Stack gap={6} style={{ flex: "1 1 auto", minWidth: 0 }}>
              <Text fw="var(--norea-weight-medium)" size="sm">
                {t("library.localNovel.cover")}
              </Text>
              <Group gap="xs" wrap="wrap">
                <Button
                  disabled={!coverPickerSupported || pickingCover || save.isPending}
                  loading={pickingCover}
                  onClick={() => void handleChooseCover()}
                  size="xs"
                  type="button"
                  variant="default"
                >
                  {t("library.localNovel.coverChoose")}
                </Button>
                {hasCoverOverride ? (
                  <Button
                    disabled={pickingCover || save.isPending}
                    onClick={handleFollowSourceCover}
                    size="xs"
                    type="button"
                    variant="subtle"
                  >
                    {t("novel.metadataOverride.useSourceCover")}
                  </Button>
                ) : null}
              </Group>
              <Text c="dimmed" size="xs">
                {coverPickerSupported
                  ? t("novel.metadataOverride.coverHelp")
                  : t("novel.metadataOverride.coverRequiresLibrary")}
              </Text>
              {coverError ? (
                <Text c="danger" role="alert" size="xs">
                  {coverError}
                </Text>
              ) : null}
            </Stack>
          </Group>

          <TextInput
            label={renderFieldLabel(t("library.localNovel.name"), form.name.followSource, () =>
              setForm((current) => ({
                ...current,
                name: { text: sourceMetadata.name, followSource: true },
              })),
            )}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setForm((current) => ({
                ...current,
                name: { text: value, followSource: false },
              }));
            }}
            required
            value={form.name.text}
          />

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={renderFieldLabel(t("library.localNovel.author"), form.author.followSource, () =>
                setForm((current) => ({
                  ...current,
                  author: { text: sourceMetadata.author ?? "", followSource: true },
                })),
              )}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({
                  ...current,
                  author: { text: value, followSource: false },
                }));
              }}
              value={form.author.text}
            />
            <TextInput
              label={renderFieldLabel(t("library.localNovel.artist"), form.artist.followSource, () =>
                setForm((current) => ({
                  ...current,
                  artist: { text: sourceMetadata.artist ?? "", followSource: true },
                })),
              )}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({
                  ...current,
                  artist: { text: value, followSource: false },
                }));
              }}
              value={form.artist.text}
            />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Select
              allowDeselect={false}
              data={statusOptions}
              label={t("novel.metadataOverride.status")}
              onChange={(value) => {
                setForm((current) => ({
                  ...current,
                  status: !value || value === FOLLOW_SOURCE_STATUS_VALUE ? null : value,
                }));
              }}
              value={form.status ?? FOLLOW_SOURCE_STATUS_VALUE}
            />
            <TextInput
              label={renderFieldLabel(t("library.localNovel.genres"), form.genres.followSource, () =>
                setForm((current) => ({
                  ...current,
                  genres: { text: sourceMetadata.genres ?? "", followSource: true },
                })),
              )}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((current) => ({
                  ...current,
                  genres: { text: value, followSource: false },
                }));
              }}
              value={form.genres.text}
            />
          </SimpleGrid>

          <Textarea
            autosize
            label={renderFieldLabel(t("library.localNovel.summary"), form.summary.followSource, () =>
              setForm((current) => ({
                ...current,
                summary: { text: sourceMetadata.summary ?? "", followSource: true },
              })),
            )}
            maxRows={8}
            minRows={3}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setForm((current) => ({
                ...current,
                summary: { text: value, followSource: false },
              }));
            }}
            value={form.summary.text}
          />

          {save.error ? (
            <StatusAlert color="danger" role="alert">
              {describeError(save.error)}
            </StatusAlert>
          ) : null}
        </Stack>
      </form>
    </ResponsiveSheet>
  );
}
