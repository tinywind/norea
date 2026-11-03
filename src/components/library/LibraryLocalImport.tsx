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
import { upsertLocalNovel } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { clearLocalImportFileCache } from "../../lib/local-import";
import { importLocalFileToLibrary } from "../../lib/local-import-library";
import { LOCAL_NOVEL_NAME, LOCAL_NOVEL_PATH } from "../../lib/local-library-identity";
import { useLibraryStore } from "../../store/library";
import { TextButton } from "../TextButton";
import {
  beginLocalImport,
  getLocalImportResultCounts,
  isLocalImportBusy,
  replaceLocalImportItem,
  startLocalImportBatch,
  updateLocalImportBatch,
  type LocalImportBatch,
} from "./local-import-batch";
import {
  analyzeLocalImportReviewItem,
  getLocalImportErrorMessage,
  getLocalImportSummary,
  markSelectedLocalImportDuplicates,
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
  const [batch, setBatch] = useState<LocalImportBatch | null>(null);
  const [waitingFiles, setWaitingFiles] = useState<readonly File[]>([]);
  const nextBatchIdRef = useRef(0);
  const activeBatchIdRef = useRef<number | null>(null);

  const openLocalHome = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: () => upsertLocalNovel({ name: LOCAL_NOVEL_NAME, path: LOCAL_NOVEL_PATH, chapters: [] }),
    onSuccess: ({ novelId }) => {
      void queryClient.invalidateQueries({ queryKey: ["category"] });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
      void navigate({ to: "/novel", search: { id: novelId } });
    },
  });

  const startBatch = useCallback(async (files: readonly File[]) => {
    const id = ++nextBatchIdRef.current;
    activeBatchIdRef.current = id;
    setBatch(startLocalImportBatch(id));
    const analyzedItems = await Promise.all(
      files.map((file, index) => analyzeLocalImportReviewItem(file, index)),
    );
    if (activeBatchIdRef.current !== id) {
      for (const item of analyzedItems) clearLocalImportFileCache(item.file);
      return;
    }
    setBatch((current) =>
      updateLocalImportBatch(current, id, (started) => ({
        ...started,
        items: markSelectedLocalImportDuplicates(analyzedItems),
        phase: "review",
      })),
    );
  }, []);

  const requestImport = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (activeBatchIdRef.current !== null) {
        setWaitingFiles((current) => [...current, ...files]);
        return;
      }
      void startBatch(files);
    },
    [startBatch],
  );

  const importReadyFiles = useCallback(async () => {
    if (!batch || batch.phase !== "review") return;
    const { id } = batch;
    const importing = beginLocalImport(batch);
    setBatch(importing);
    let importedNovelId: number | null = null;

    for (const item of batch.items.filter((entry) => entry.status === "ready")) {
      let next: LocalImportReviewItem;
      try {
        const result = await importLocalFileToLibrary(item.file, {
          analysis: item.analysis,
        });
        importedNovelId = result.novelId;
        next = {
          ...item,
          error: undefined,
          importedChapterCount: result.chapterCount,
          importedNovelId: result.novelId,
          status: "imported",
        };
      } catch (error) {
        next = {
          ...item,
          error: getLocalImportErrorMessage(error) || t("library.localImport.error"),
          status: "error",
        };
      } finally {
        clearLocalImportFileCache(item.file);
      }
      setBatch((current) =>
        updateLocalImportBatch(current, id, (started) =>
          replaceLocalImportItem(started, next),
        ),
      );
    }

    void queryClient.invalidateQueries({ queryKey: ["category"] });
    void queryClient.invalidateQueries({ queryKey: ["novel"] });
    void queryClient.invalidateQueries({ queryKey: ["chapter"] });
    if (activeBatchIdRef.current !== id) return;

    if (batch.items.length === 1 && importedNovelId !== null) {
      activeBatchIdRef.current = null;
      setBatch(null);
      void navigate({ to: "/novel", search: { id: importedNovelId } });
      return;
    }
    setBatch((current) =>
      updateLocalImportBatch(current, id, (started) => ({ ...started, phase: "result" })),
    );
  }, [batch, navigate, queryClient, t]);

  const dismissBatch = useCallback(() => {
    if (!batch || isLocalImportBusy(batch)) return;
    for (const item of batch.items) clearLocalImportFileCache(item.file);
    activeBatchIdRef.current = null;
    setBatch(null);
    if (waitingFiles.length > 0) {
      setWaitingFiles([]);
      void startBatch(waitingFiles);
    }
  }, [batch, startBatch, waitingFiles]);

  // A queued request starts once the single-file shortcut has left the modal closed.
  useEffect(() => {
    if (batch !== null || activeBatchIdRef.current !== null || waitingFiles.length === 0) return;
    setWaitingFiles([]);
    void startBatch(waitingFiles);
  }, [batch, startBatch, waitingFiles]);

  useEffect(() => {
    if (pendingLocalImportFiles.length === 0) return;
    requestImport(takePendingLocalImportFiles());
  }, [pendingLocalImportFiles, requestImport, takePendingLocalImportFiles]);

  const handleLocalImportFilesSelected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      requestImport(files);
    },
    [requestImport],
  );

  const busy = isLocalImportBusy(batch);
  const items = batch?.items ?? [];
  const readyCount = items.filter((item) => item.status === "ready").length;
  const result = batch?.phase === "result" ? getLocalImportResultCounts(batch) : null;
  const localHomeErrorOpen = active && Boolean(openLocalHome.error);
  useOverlayBackNavigation(active && batch !== null, dismissBatch);
  useOverlayBackNavigation(localHomeErrorOpen, () => openLocalHome.reset());

  useImperativeHandle(
    ref,
    () => ({
      openFilePicker: () => localImportInputRef.current?.click(),
      openLocalHome: () => openLocalHome.mutate(),
    }),
    [openLocalHome],
  );
  return (
    <>
      <input
        ref={localImportInputRef}
        accept={LOCAL_IMPORT_ACCEPT}
        className="norea-library-file-input"
        multiple
        onChange={handleLocalImportFilesSelected}
        type="file"
      />
      <Modal
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
        onClose={dismissBatch}
        opened={active && batch !== null}
        size="lg"
        title={t("library.localImport.title")}
        withCloseButton={!busy}
      >
        <Stack gap="sm">
          {batch?.phase === "analyzing" ? (
            <Group gap="xs" role="status">
              <Loader size="sm" />
              <Text c="dimmed" size="sm">
                {t("library.localImport.analyzing")}
              </Text>
            </Group>
          ) : null}

          {items.length > 0 ? (
            <div className="norea-library-local-import-list">
              {items.map((item) => (
                <LocalImportReviewRow
                  item={item}
                  key={item.id}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
          ) : null}

          {waitingFiles.length > 0 ? (
            <Text c="dimmed" size="sm">
              {t("library.localImport.waiting", { count: waitingFiles.length })}
            </Text>
          ) : null}

          <Group justify="space-between" wrap="wrap">
            <Text aria-live="polite" c="dimmed" size="sm">
              {result
                ? t("library.localImport.result", result)
                : batch?.phase === "analyzing"
                  ? null
                  : getLocalImportSummary(items, t)}
            </Text>
            {result ? (
              <Group gap="xs">
                <TextButton
                  onClick={() => {
                    dismissBatch();
                    openLocalHome.mutate();
                  }}
                  type="button"
                  variant="subtle"
                >
                  {t("library.localNovel.create")}
                </TextButton>
                <TextButton onClick={dismissBatch} type="button">
                  {t("common.done")}
                </TextButton>
              </Group>
            ) : (
              <Group gap="xs">
                <TextButton
                  disabled={busy}
                  onClick={dismissBatch}
                  type="button"
                  variant="subtle"
                >
                  {t("common.cancel")}
                </TextButton>
                <TextButton
                  disabled={busy || readyCount === 0}
                  loading={batch?.phase === "importing"}
                  onClick={() => void importReadyFiles()}
                  type="button"
                >
                  {t("library.localImport.importReady", { count: readyCount })}
                </TextButton>
              </Group>
            )}
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={localHomeErrorOpen}
        onClose={() => openLocalHome.reset()}
        title={t("library.localNovel.title")}
      >
        <Text c="danger" role="alert">{getLocalImportErrorMessage(openLocalHome.error)}</Text>
      </Modal>
    </>
  );
});
