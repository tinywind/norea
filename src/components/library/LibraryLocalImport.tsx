import {
  Group,
  Loader,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  upsertLocalNovel,
  type LocalNovelImportResult,
} from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { clearLocalImportFileCache } from "../../lib/local-import";
import { importLocalFileToLibrary } from "../../lib/local-import-library";
import { LOCAL_NOVEL_NAME, LOCAL_NOVEL_PATH } from "../../lib/local-library-identity";
import { useLibraryStore } from "../../store/library";
import { TextButton } from "../TextButton";
import {
  analyzeLocalImportReviewItem,
  getLocalImportErrorMessage,
  getLocalImportSummary,
  markSelectedLocalImportDuplicates,
  type LocalImportItemResult,
  type LocalImportReviewItem,
} from "./local-import-review";
import { LocalImportReviewRow } from "./LocalImportReviewRow";
const LOCAL_IMPORT_ACCEPT = ".txt,.html,.htm,.md,.markdown,.epub,.pdf";
export interface LibraryLocalImportHandle {
  openFilePicker: () => void;
  openLocalHome: () => void;
}

export const LibraryLocalImport = forwardRef<
  LibraryLocalImportHandle,
  { active: boolean }
>(function LibraryLocalImport({ active }, ref) {
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pendingLocalImportFiles = useLibraryStore(
    (s) => s.pendingLocalImportFiles,
  );
  const takePendingLocalImportFiles = useLibraryStore(
    (s) => s.takePendingLocalImportFiles,
  );
  const localImportInputRef = useRef<HTMLInputElement>(null);
  const [localImportOpen, setLocalImportOpen] = useState(false);
  const [localImportItems, setLocalImportItems] = useState<
    LocalImportReviewItem[]
  >([]);
  const [localImportAnalyzing, setLocalImportAnalyzing] = useState(false);
  const localImportMutation = useMutation({
    mutationFn: async (
      items: readonly LocalImportReviewItem[],
    ): Promise<LocalImportItemResult[]> => {
      const results: LocalImportItemResult[] = [];

      for (const item of items) {
        try {
          const result = await importLocalFileToLibrary(item.file, {
            analysis: item.analysis,
          });
          results.push({ itemId: item.id, result, status: "imported" });
        } catch (error) {
          results.push({
            error: getLocalImportErrorMessage(error),
            itemId: item.id,
            status: "error",
          });
        } finally {
          clearLocalImportFileCache(item.file);
        }
      }

      return results;
    },
    onMutate: (items) => {
      const importingIds = new Set(items.map((item) => item.id));
      setLocalImportItems((current) =>
        current.map((item) =>
          importingIds.has(item.id) ? { ...item, status: "importing" } : item,
        ),
      );
    },
    onSuccess: (results) => {
      const resultById = new Map(
        results.map((result) => [result.itemId, result]),
      );
      setLocalImportItems((current) =>
        current.map((item) => {
          const result = resultById.get(item.id);
          if (!result) return item;

          if (result.status === "imported" && result.result) {
            return {
              ...item,
              error: undefined,
              importedChapterCount: result.result.chapterCount,
              importedNovelId: result.result.novelId,
              status: "imported",
            };
          }

          return {
            ...item,
            error: result.error ?? t("library.localImport.error"),
            status: "error",
          };
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
      void queryClient.invalidateQueries({ queryKey: ["chapter"] });

      const imported = results.filter(
        (
          result,
        ): result is LocalImportItemResult & {
          result: LocalNovelImportResult;
          status: "imported";
        } => result.status === "imported" && !!result.result,
      );
      if (results.length === 1 && imported.length === 1) {
        setLocalImportOpen(false);
        void navigate({
          to: "/novel",
          search: { id: imported[0].result.novelId },
        });
      }
    },
  });

  const openLocalHome = useMutation({
    mutationFn: () => upsertLocalNovel({ name: LOCAL_NOVEL_NAME, path: LOCAL_NOVEL_PATH, chapters: [] }),
    onSuccess: ({ novelId }) => {
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
      void navigate({ to: "/novel", search: { id: novelId } });
    },
  });

  const openLocalImportInput = useCallback(() => {
    localImportMutation.reset();
    localImportInputRef.current?.click();
  }, [localImportMutation]);

  const closeLocalImportReview = useCallback(() => {
    if (localImportMutation.isPending) return;
    localImportMutation.reset();
    for (const item of localImportItems) {
      clearLocalImportFileCache(item.file);
    }
    setLocalImportOpen(false);
    setLocalImportItems([]);
  }, [localImportItems, localImportMutation]);

  const reviewLocalImportFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      localImportMutation.reset();
      for (const item of localImportItems) {
        clearLocalImportFileCache(item.file);
      }
      setLocalImportOpen(true);
      setLocalImportAnalyzing(true);
      setLocalImportItems([]);

      const analyzedItems = await Promise.all(
        files.map((file, index) => analyzeLocalImportReviewItem(file, index)),
      );
      setLocalImportItems(markSelectedLocalImportDuplicates(analyzedItems));
      setLocalImportAnalyzing(false);
    },
    [localImportItems, localImportMutation],
  );

  const localImportReviewQueueRef = useRef(Promise.resolve());
  const queueLocalImportReview = useCallback(
    (files: readonly File[]) => {
      localImportReviewQueueRef.current =
        localImportReviewQueueRef.current.then(() =>
          reviewLocalImportFiles(files),
        );
      return localImportReviewQueueRef.current;
    },
    [reviewLocalImportFiles],
  );

  useEffect(() => {
    if (pendingLocalImportFiles.length === 0) return;
    const files = takePendingLocalImportFiles();
    void queueLocalImportReview(files);
  }, [
    pendingLocalImportFiles,
    queueLocalImportReview,
    takePendingLocalImportFiles,
  ]);

  const handleLocalImportFilesSelected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      void queueLocalImportReview(files);
    },
    [queueLocalImportReview],
  );

  const readyLocalImportItems = localImportItems.filter(
    (item) => item.status === "ready",
  );
  const localImportSummary = localImportAnalyzing
    ? t("library.localImport.analyzing")
    : getLocalImportSummary(localImportItems, t);

  useImperativeHandle(
    ref,
    () => ({
      openFilePicker: openLocalImportInput,
      openLocalHome: () => openLocalHome.mutate(),
    }),
    [openLocalImportInput, openLocalHome],
  );
  return (
    <>
      {" "}
      <input
        ref={localImportInputRef}
        accept={LOCAL_IMPORT_ACCEPT}
        className="norea-library-file-input"
        multiple
        onChange={handleLocalImportFilesSelected}
        type="file"
      />
      <Modal
        opened={active && localImportOpen}
        onClose={closeLocalImportReview}
        size="lg"
        title={t("library.localImport.title")}
      >
        <Stack gap="sm">
          {localImportAnalyzing ? (
            <Group gap="xs">
              <Loader size="sm" />
              <Text c="dimmed" size="sm">
                {t("library.localImport.analyzing")}
              </Text>
            </Group>
          ) : null}

          {localImportItems.length > 0 ? (
            <div className="norea-library-local-import-list">
              {localImportItems.map((item) => (
                <LocalImportReviewRow
                  item={item}
                  key={item.id}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
          ) : null}

          {localImportMutation.error ? (
            <Text c="red" size="sm">
              {getLocalImportErrorMessage(localImportMutation.error)}
            </Text>
          ) : null}

          <Group justify="space-between" wrap="wrap">
            <Text c="dimmed" size="sm">
              {localImportSummary}
            </Text>
            <Group gap="xs">
              <TextButton
                disabled={localImportMutation.isPending}
                onClick={closeLocalImportReview}
                type="button"
                variant="subtle"
              >
                {t("common.cancel")}
              </TextButton>
              <TextButton
                disabled={
                  localImportAnalyzing ||
                  readyLocalImportItems.length === 0 ||
                  localImportMutation.isPending
                }
                loading={localImportMutation.isPending}
                onClick={() =>
                  localImportMutation.mutate(readyLocalImportItems)
                }
                type="button"
              >
                {t("library.localImport.importReady", {
                  count: readyLocalImportItems.length,
                })}
              </TextButton>
            </Group>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={active && Boolean(openLocalHome.error)}
        onClose={() => openLocalHome.reset()}
        title={t("library.localNovel.title")}
      >
        <Text c="red">{getLocalImportErrorMessage(openLocalHome.error)}</Text>
      </Modal>
    </>
  );
});
