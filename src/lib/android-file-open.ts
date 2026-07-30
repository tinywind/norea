import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
  describeAndroidContentUri,
  type AndroidContentUriDescriptor,
} from "./android-storage";
import { localImportFileSizeLimit } from "./local-import";

const ANDROID_OPEN_FILES_EVENT = "android-open-files";

export interface AndroidFileOpenHandlers {
  onError?: (error: unknown) => void;
  onFiles: (files: readonly File[]) => Promise<void> | void;
}

function descriptorFile(descriptor: AndroidContentUriDescriptor): File {
  const file = new File([], descriptor.fileName, {
    type: descriptor.mimeType,
  });
  if (descriptor.size !== null) {
    Object.defineProperty(file, "size", {
      configurable: true,
      value: descriptor.size,
    });
  }
  return file;
}

function unreadableFile(
  descriptor: AndroidContentUriDescriptor,
  error: unknown,
): File {
  const file = descriptorFile(descriptor);
  const readError =
    error instanceof Error ? error : new Error("Android file read failed.");
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => {
      throw readError;
    },
  });
  return file;
}

function fallbackDescriptor(uri: string): AndroidContentUriDescriptor {
  let fileName = "opened-file";
  try {
    const encodedName = new URL(uri).pathname.split("/").pop();
    const decodedName = encodedName ? decodeURIComponent(encodedName) : "";
    fileName =
      decodedName.split("/").pop()?.split(":").pop()?.trim() || fileName;
  } catch {
    // The original descriptor error is reported by the caller.
  }
  return {
    fileName,
    mimeType: "application/octet-stream",
    size: null,
  };
}

async function takeAndroidOpenFile(
  uri: string,
  onError?: (error: unknown) => void,
): Promise<File> {
  let descriptor: AndroidContentUriDescriptor;
  try {
    descriptor = await describeAndroidContentUri(uri);
  } catch (error) {
    onError?.(error);
    return unreadableFile(fallbackDescriptor(uri), error);
  }

  let limit: number;
  try {
    limit = localImportFileSizeLimit({
      name: descriptor.fileName,
      type: descriptor.mimeType,
    });
  } catch {
    return descriptorFile(descriptor);
  }
  if (descriptor.size !== null && descriptor.size > limit) {
    return descriptorFile(descriptor);
  }

  try {
    const tempFile = await copyAndroidContentUriToTempFile(uri, limit);
    if (!tempFile) {
      throw new Error("Android content URI temp-file bridge is unavailable.");
    }
    try {
      const bytes = await invoke<ArrayBuffer>("android_open_file_temp_read", {
        path: tempFile.path,
      });
      const file = new File([bytes], descriptor.fileName, {
        type: descriptor.mimeType,
      });
      if (file.size !== tempFile.bytes) {
        throw new Error("Android opened file size changed while it was read.");
      }
      return file;
    } finally {
      try {
        await deleteAndroidContentUriTempFile(tempFile);
      } catch (error) {
        onError?.(error);
      }
    }
  } catch (error) {
    onError?.(error);
    return unreadableFile(descriptor, error);
  }
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
