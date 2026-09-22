import { Group, Modal, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  listChaptersByNovel,
  type ChapterListRow,
} from "../../db/queries/chapter";
import {
  reorderLocalNovelChapters,
  updateLocalNovelMetadata,
  upsertLocalNovelChapters,
  type LocalNovelImportChapterInput,
  type LocalNovelMetadataInput,
  type NovelDetailRecord,
} from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { syncLocalChapterStorageAfterOrderChange } from "../../lib/local-chapter-storage";
import {
  clearLocalImportFileCache,
  convertLocalImportFile,
} from "../../lib/local-import";
import { cacheLocalImportedChapterMedia } from "../../lib/local-import-media";
import { type DefaultChapterSort } from "../../store/library";
import { LocalCoverPicker } from "../LocalCoverPicker";
import { TextButton } from "../TextButton";
import { chaptersKey, novelKey } from "./novel-detail-model";
const LOCAL_IMPORT_ACCEPT = ".txt,.html,.htm,.md,.markdown,.epub,.pdf";
const EMPTY_LOCAL_NOVEL_FORM: LocalNovelMetadataInput = {
  name: "",
  cover: "",
  summary: "",
  author: "",
  artist: "",
  status: "",
  genres: "",
};

function localMetadataFromNovel(
  novel: Pick<
    NovelDetailRecord,
    "name" | "cover" | "summary" | "author" | "artist" | "status" | "genres"
  >,
): LocalNovelMetadataInput {
  return {
    name: novel.name,
    cover: novel.cover ?? "",
    summary: novel.summary ?? "",
    author: novel.author ?? "",
    artist: novel.artist ?? "",
    status: novel.status ?? "",
    genres: novel.genres ?? "",
  };
}

async function convertLocalChapterFiles(
  files: readonly File[],
  startPosition: number,
): Promise<LocalNovelImportChapterInput[]> {
  const chapters: LocalNovelImportChapterInput[] = [];

  for (const file of files) {
    try {
      const conversion = await convertLocalImportFile(file);
      for (const chapter of conversion.chapters) {
        chapters.push({
          binaryResource: chapter.binaryResource,
          chapterNumber:
            chapter.chapterNumber == null
              ? null
              : String(chapter.chapterNumber),
          content: chapter.content,
          contentBytes: chapter.contentBytes,
          contentType: chapter.contentType,
          mediaResources: chapter.mediaResources,
          name: chapter.name,
          page: chapter.page,
          path: chapter.path,
          position: startPosition + chapters.length + 1,
          releaseTime: chapter.releaseTime ?? null,
        });
      }
    } finally {
      clearLocalImportFileCache(file);
    }
  }

  return chapters;
}

type EditableLocalNovel = Pick<
  NovelDetailRecord,
  | "id"
  | "name"
  | "path"
  | "pluginId"
  | "isLocal"
  | "cover"
  | "summary"
  | "author"
  | "artist"
  | "status"
  | "genres"
>;

export function useLocalNovelEditor(
  id: number,
  novel: EditableLocalNovel | null | undefined,
  chapters: readonly Pick<ChapterListRow, "id" | "position">[],
  defaultChapterSort: DefaultChapterSort,
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const localChapterInputRef = useRef<HTMLInputElement>(null);
  const [localChapterError, setLocalChapterError] = useState<string | null>(
    null,
  );
  const [localMetadataOpen, setLocalMetadataOpen] = useState(false);
  const [localMetadataForm, setLocalMetadataForm] =
    useState<LocalNovelMetadataInput>(EMPTY_LOCAL_NOVEL_FORM);
  const addLocalChapters = useMutation({
    mutationFn: async (files: readonly File[]) => {
      const startPosition =
        chapters.reduce(
          (maxPosition, chapter) => Math.max(maxPosition, chapter.position),
          0,
        ) ?? 0;
      const importedChapters = await convertLocalChapterFiles(
        files,
        startPosition,
      );
      if (importedChapters.length === 0) return null;
      const previousChapters = await listChaptersByNovel(id);
      const result = await upsertLocalNovelChapters(id, importedChapters);
      if (novel) {
        const nextChapters = await listChaptersByNovel(id);
        await syncLocalChapterStorageAfterOrderChange({
          nextChapters,
          novel,
          previousChapters,
        });
        await cacheLocalImportedChapterMedia({
          chapters: importedChapters,
          novelId: id,
          novelName: novel.name,
          novelPath: novel.path,
        });
      }
      return result;
    },
    onSuccess: () => {
      setLocalChapterError(null);
      void queryClient.invalidateQueries({ queryKey: chaptersKey(id) });
      void queryClient.invalidateQueries({ queryKey: novelKey(id) });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
    onError: (error) => {
      setLocalChapterError(
        error instanceof Error ? error.message : String(error),
      );
    },
  });

  const reorderLocalChapters = useMutation({
    mutationFn: async (chapterIds: number[]) => {
      if (!novel?.isLocal) return;
      const previousChapters = await listChaptersByNovel(id);
      await reorderLocalNovelChapters(id, chapterIds);
      const nextChapters = await listChaptersByNovel(id);
      await syncLocalChapterStorageAfterOrderChange({
        nextChapters,
        novel,
        previousChapters,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chaptersKey(id) });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
  });

  const updateLocalMetadata = useMutation({
    mutationFn: (input: LocalNovelMetadataInput) =>
      updateLocalNovelMetadata(id, input),
    onSuccess: () => {
      setLocalMetadataOpen(false);
      void queryClient.invalidateQueries({ queryKey: novelKey(id) });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
  });

  useEffect(() => {
    if (!novel?.isLocal) return;
    setLocalMetadataForm(localMetadataFromNovel(novel));
  }, [novel]);

  function openLocalChapterInput(): void {
    addLocalChapters.reset();
    setLocalChapterError(null);
    localChapterInputRef.current?.click();
  }

  function handleLocalChapterFilesSelected(
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;

    if (!novel?.isLocal) return;
    addLocalChapters.mutate(files);
  }

  function openLocalMetadataEditor(): void {
    if (!novel?.isLocal) return;
    updateLocalMetadata.reset();
    setLocalMetadataForm(localMetadataFromNovel(novel));
    setLocalMetadataOpen(true);
  }

  function closeLocalMetadataEditor(): void {
    if (updateLocalMetadata.isPending) return;
    updateLocalMetadata.reset();
    setLocalMetadataOpen(false);
  }

  function handleLocalMetadataSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!novel?.isLocal || localMetadataForm.name.trim() === "") return;
    updateLocalMetadata.mutate(localMetadataForm);
  }

  function reorderLocalChapter(
    chapterId: number,
    beforeChapterId: number | null,
  ): void {
    if (!novel?.isLocal || reorderLocalChapters.isPending) return;

    const displayOrder = [...chapters];
    const currentIndex = displayOrder.findIndex(
      (chapter) => chapter.id === chapterId,
    );
    if (currentIndex < 0) return;

    const [chapter] = displayOrder.splice(currentIndex, 1);
    if (!chapter) return;

    if (beforeChapterId === null) {
      displayOrder.push(chapter);
    } else {
      const beforeIndex = displayOrder.findIndex(
        (candidate) => candidate.id === beforeChapterId,
      );
      if (beforeIndex < 0) return;
      displayOrder.splice(beforeIndex, 0, chapter);
    }

    const readingOrder =
      defaultChapterSort === "desc"
        ? [...displayOrder].reverse()
        : displayOrder;
    reorderLocalChapters.mutate(readingOrder.map((chapter) => chapter.id));
  }

  const editor = (
    <>
      {" "}
      <input
        ref={localChapterInputRef}
        accept={LOCAL_IMPORT_ACCEPT}
        className="norea-novel-file-input"
        multiple
        onChange={handleLocalChapterFilesSelected}
        type="file"
      />
      <Modal
        opened={Boolean(novel?.isLocal) && localMetadataOpen}
        onClose={closeLocalMetadataEditor}
        size="lg"
        title={t("novel.local.editMetadata")}
      >
        <form onSubmit={handleLocalMetadataSubmit}>
          <Stack gap="sm">
            <TextInput
              autoFocus
              label={t("library.localNovel.name")}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setLocalMetadataForm((current) => ({
                  ...current,
                  name: value,
                }));
              }}
              required
              value={localMetadataForm.name}
            />
            <Group grow>
              <TextInput
                label={t("library.localNovel.author")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalMetadataForm((current) => ({
                    ...current,
                    author: value,
                  }));
                }}
                value={localMetadataForm.author ?? ""}
              />
              <TextInput
                label={t("library.localNovel.artist")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalMetadataForm((current) => ({
                    ...current,
                    artist: value,
                  }));
                }}
                value={localMetadataForm.artist ?? ""}
              />
            </Group>
            <Group grow>
              <TextInput
                label={t("library.localNovel.status")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalMetadataForm((current) => ({
                    ...current,
                    status: value,
                  }));
                }}
                value={localMetadataForm.status ?? ""}
              />
              <TextInput
                label={t("library.localNovel.genres")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalMetadataForm((current) => ({
                    ...current,
                    genres: value,
                  }));
                }}
                value={localMetadataForm.genres ?? ""}
              />
            </Group>
            <LocalCoverPicker
              alt={localMetadataForm.name || t("library.localNovel.name")}
              disabled={updateLocalMetadata.isPending}
              onChange={(cover) =>
                setLocalMetadataForm((current) => ({
                  ...current,
                  cover,
                }))
              }
              value={localMetadataForm.cover}
            />
            <Textarea
              autosize
              label={t("library.localNovel.summary")}
              minRows={4}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setLocalMetadataForm((current) => ({
                  ...current,
                  summary: value,
                }));
              }}
              value={localMetadataForm.summary ?? ""}
            />
            {updateLocalMetadata.error ? (
              <Text c="red" size="sm">
                {updateLocalMetadata.error instanceof Error
                  ? updateLocalMetadata.error.message
                  : String(updateLocalMetadata.error)}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <TextButton
                disabled={updateLocalMetadata.isPending}
                onClick={closeLocalMetadataEditor}
                type="button"
                variant="subtle"
              >
                {t("common.cancel")}
              </TextButton>
              <TextButton
                disabled={
                  localMetadataForm.name.trim() === "" ||
                  updateLocalMetadata.isPending
                }
                loading={updateLocalMetadata.isPending}
                type="submit"
              >
                {t("common.save")}
              </TextButton>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
  return {
    addLocalChapters,
    reorderLocalChapters,
    localChapterError,
    openLocalChapterInput,
    openLocalMetadataEditor,
    reorderLocalChapter,
    editor,
  };
}
