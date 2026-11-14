import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface LocalFileDescriptor {
  fileName: string;
  mimeType: string;
  size: number | null;
}

export interface PickLocalFilesOptions {
  extensions?: string[];
  filterName?: string;
  multiple?: boolean;
  maxBytesForFile: (descriptor: LocalFileDescriptor) => number | null;
}

export function descriptorOnlyFile(descriptor: LocalFileDescriptor): File {
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

export function unreadableDescriptorFile(
  descriptor: LocalFileDescriptor,
  error: unknown,
): File {
  const file = descriptorOnlyFile(descriptor);
  const readError =
    error instanceof Error ? error : new Error("Local file read failed.");
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => {
      throw readError;
    },
  });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: async () => {
      throw readError;
    },
  });
  return file;
}

export function fallbackLocalFileDescriptor(
  pathOrUri: string,
): LocalFileDescriptor {
  let fileName = "opened-file";
  try {
    const rawSegment = pathOrUri.includes("://")
      ? new URL(pathOrUri).pathname.split("/").pop()
      : pathOrUri.split(/[/\\]/).pop();
    const decodedName = rawSegment ? decodeURIComponent(rawSegment) : "";
    fileName =
      decodedName.split("/").pop()?.split(":").pop()?.trim() || fileName;
  } catch {
    // Caller reports the original descriptor failure.
  }
  return {
    fileName,
    mimeType: "application/octet-stream",
    size: null,
  };
}

function normalizeIpcBytes(raw: unknown): Uint8Array<ArrayBuffer> {
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    const copy = new Uint8Array(raw.byteLength);
    copy.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    return copy;
  }
  if (Array.isArray(raw)) {
    return Uint8Array.from(raw);
  }
  throw new Error("local_file_read returned an invalid byte payload.");
}

export async function describeLocalFile(
  pathOrUri: string,
): Promise<LocalFileDescriptor> {
  return invoke<LocalFileDescriptor>("local_file_describe", {
    pathOrUri,
  });
}

export async function readLocalPathOrUriBytes(
  pathOrUri: string,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await invoke<unknown>("local_file_read", {
    maxBytes,
    pathOrUri,
  });
  return normalizeIpcBytes(raw);
}

export async function readLocalPathOrUriAsFile(
  pathOrUri: string,
  maxBytesForFile: (descriptor: LocalFileDescriptor) => number | null,
  onError?: (error: unknown) => void,
): Promise<File> {
  let descriptor: LocalFileDescriptor;
  try {
    descriptor = await describeLocalFile(pathOrUri);
  } catch (error) {
    onError?.(error);
    return unreadableDescriptorFile(
      fallbackLocalFileDescriptor(pathOrUri),
      error,
    );
  }

  let limit: number | null;
  try {
    limit = maxBytesForFile(descriptor);
  } catch {
    return descriptorOnlyFile(descriptor);
  }
  if (limit === null) {
    return descriptorOnlyFile(descriptor);
  }
  if (descriptor.size !== null && descriptor.size > limit) {
    return descriptorOnlyFile(descriptor);
  }

  try {
    const bytes = await readLocalPathOrUriBytes(pathOrUri, limit);
    return new File([bytes], descriptor.fileName, {
      type: descriptor.mimeType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      descriptor.size === null &&
      /exceeds (?:size|the \d+ byte) limit/i.test(message)
    ) {
      return descriptorOnlyFile({
        ...descriptor,
        size: limit + 1,
      });
    }
    onError?.(error);
    return unreadableDescriptorFile(descriptor, error);
  }
}

export async function pickLocalFiles({
  extensions,
  filterName = "Files",
  multiple = false,
  maxBytesForFile,
}: PickLocalFilesOptions): Promise<File[]> {
  const selected = await open({
    multiple,
    ...(extensions && extensions.length > 0
      ? { filters: [{ name: filterName, extensions }] }
      : {}),
  });
  if (selected === null) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  const files: File[] = [];
  for (const pathOrUri of paths) {
    files.push(await readLocalPathOrUriAsFile(pathOrUri, maxBytesForFile));
  }
  return files;
}
