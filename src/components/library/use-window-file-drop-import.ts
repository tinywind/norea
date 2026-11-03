import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "../../i18n";
import { isSupportedLocalImportFile } from "../../lib/local-import";
import { useLibraryStore } from "../../store/library";

export interface DroppedFileImportHandlers {
  notifyUnsupported: (files: readonly File[]) => void;
  openLibrary: () => void;
  queue: (files: readonly File[]) => void;
}

/** Sends supported dropped files to the queued import review and reports the rest. */
export function importDroppedFiles(files: readonly File[], handlers: DroppedFileImportHandlers): void {
  const supported = files.filter(isSupportedLocalImportFile);
  const unsupported = files.filter((file) => !isSupportedLocalImportFile(file));
  if (supported.length > 0) {
    handlers.queue(supported);
    handlers.openLibrary();
  }
  if (unsupported.length > 0) handlers.notifyUnsupported(unsupported);
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

/**
 * RD14: files dropped anywhere on the window open the Library import review,
 * the same queue as Import files. The main window turns off Tauri's native
 * drag-drop handling (tauri.conf.json), so the WebView delivers the File objects.
 */
export function useWindowFileDropImport(enabled: boolean): void {
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!enabled) return;
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      importDroppedFiles(Array.from(event.dataTransfer?.files ?? []), {
        notifyUnsupported: (files) => {
          notifications.show({
            color: "warn",
            message: files.map((file) => file.name).join(", "),
            title: t("library.dropImport.unsupported", { count: files.length }),
          });
        },
        openLibrary: () => void navigate({ to: "/" }),
        queue: (files) => useLibraryStore.getState().queueLocalImportFiles(files),
      });
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled, navigate, t]);
}
