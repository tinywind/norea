import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readLocalPathOrUriAsFile } from "./local-file-picker";
import { localImportFileSizeLimit } from "./local-import";

const ANDROID_OPEN_FILES_EVENT = "android-open-files";

export interface AndroidFileOpenHandlers {
  onError?: (error: unknown) => void;
  onFiles: (files: readonly File[]) => Promise<void> | void;
}

function takeAndroidOpenFile(
  uri: string,
  onError?: (error: unknown) => void,
): Promise<File> {
  return readLocalPathOrUriAsFile(
    uri,
    (descriptor) =>
      localImportFileSizeLimit({
        name: descriptor.fileName,
        type: descriptor.mimeType,
      }),
    onError,
  );
}

export async function takePendingAndroidOpenFiles(
  onError?: (error: unknown) => void,
): Promise<File[]> {
  const uris = await invoke<string[]>("android_open_file_url_take");
  const files: File[] = [];

  for (const uri of uris) {
    files.push(await takeAndroidOpenFile(uri, onError));
  }

  return files;
}

export async function startAndroidFileOpenListener(
  handlers: AndroidFileOpenHandlers,
): Promise<() => void> {
  let active = true;
  let processing = Promise.resolve();

  const drain = () => {
    processing = processing
      .then(async () => {
        if (!active) return;
        const files = await takePendingAndroidOpenFiles(handlers.onError);
        if (files.length > 0) {
          await handlers.onFiles(files);
        }
      })
      .catch((error) => {
        handlers.onError?.(error);
      });
    return processing;
  };

  const unlisten = await listen(ANDROID_OPEN_FILES_EVENT, () => {
    void drain();
  });
  await drain();

  return () => {
    active = false;
    unlisten();
  };
}
