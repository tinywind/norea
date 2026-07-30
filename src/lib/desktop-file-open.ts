import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { localImportFileSizeLimit } from "./local-import";

const DESKTOP_OPEN_FILES_EVENT = "desktop-open-files";

export interface DesktopOpenFileDescriptor {
  fileName: string;
  id: string;
  mimeType: string;
  size: number;
}

export interface DesktopFileOpenHandlers {
  onError?: (error: unknown) => void;
  onFiles: (files: readonly File[]) => Promise<void> | void;
}

function oversizedFile(descriptor: DesktopOpenFileDescriptor): File {
  const file = new File([], descriptor.fileName, {
    type: descriptor.mimeType,
  });
  Object.defineProperty(file, "size", {
    configurable: true,
    value: descriptor.size,
  });
  return file;
}

async function takeDesktopOpenFile(
  descriptor: DesktopOpenFileDescriptor,
): Promise<File> {
  if (
    descriptor.size >
    localImportFileSizeLimit({
      name: descriptor.fileName,
      type: descriptor.mimeType,
    })
  ) {
    await invoke("desktop_open_file_discard", { id: descriptor.id });
    return oversizedFile(descriptor);
  }

  const bytes = await invoke<ArrayBuffer>("desktop_open_file_take", {
    id: descriptor.id,
  });
  const file = new File([bytes], descriptor.fileName, {
    type: descriptor.mimeType,
  });
  if (file.size !== descriptor.size) {
    throw new Error(
      `Desktop open file size changed: expected ${descriptor.size}, received ${file.size}`,
    );
  }
  return file;
}

export async function takePendingDesktopOpenFiles(
  onError?: (error: unknown) => void,
): Promise<File[]> {
  const descriptors = await invoke<DesktopOpenFileDescriptor[]>(
    "desktop_open_file_list",
  );
  const files: File[] = [];

  for (const descriptor of descriptors) {
    try {
      files.push(await takeDesktopOpenFile(descriptor));
    } catch (error) {
      onError?.(error);
    }
  }

  return files;
}

export async function startDesktopFileOpenListener(
  handlers: DesktopFileOpenHandlers,
): Promise<() => void> {
  let active = true;
  let processing = Promise.resolve();

  const drain = () => {
    processing = processing
      .then(async () => {
        if (!active) return;
        const files = await takePendingDesktopOpenFiles(handlers.onError);
        if (files.length > 0) {
          await handlers.onFiles(files);
        }
      })
      .catch((error) => {
        handlers.onError?.(error);
      });
    return processing;
  };

  const unlisten = await listen(DESKTOP_OPEN_FILES_EVENT, () => {
    void drain();
  });
  await drain();

  return () => {
    active = false;
    unlisten();
  };
}
