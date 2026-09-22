import { bytesToBase64 } from "./base64";

export const LOCAL_COVER_ACCEPT = ".avif,.gif,.jpeg,.jpg,.png,.webp";

export const LOCAL_COVER_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
} as const;

export type LocalCoverErrorCode = "too-large" | "unsupported" | "read-failed";

export class LocalCoverError extends Error {
  readonly code: LocalCoverErrorCode;

  constructor(code: LocalCoverErrorCode, message: string) {
    super(message);
    this.name = "LocalCoverError";
    this.code = code;
  }
}

const DATA_IMAGE_SOURCE_PATTERN =
  /^data:image\/(?:avif|gif|jpeg|jpg|png|webp);base64,[a-z\d+/]+=*$/i;

const IMAGE_MEDIA_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export function isLocalCoverSource(
  value: string | null | undefined,
): value is string {
  const source = value?.trim();
  return !!source && DATA_IMAGE_SOURCE_PATTERN.test(source);
}

export async function convertLocalCoverFile(file: File): Promise<string> {
  if (file.size > LOCAL_COVER_LIMITS.fileBytes) {
    throw new LocalCoverError(
      "too-large",
      "local cover: image file is too large",
    );
  }

  const mediaType = mediaTypeFromFile(file);
  if (!mediaType) {
    throw new LocalCoverError(
      "unsupported",
      "local cover: unsupported image file",
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
  } catch {
    throw new LocalCoverError(
      "read-failed",
      "local cover: failed to read image file",
    );
  }
}

function mediaTypeFromFile(file: File): string | null {
  const mediaType = file.type.trim().toLowerCase();
  if (mediaType === "image/jpg") return "image/jpeg";
  if ([...IMAGE_MEDIA_TYPES.values()].includes(mediaType)) return mediaType;

  const lowerName = file.name.trim().toLowerCase();
  const dot = lowerName.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_MEDIA_TYPES.get(lowerName.slice(dot)) ?? null;
}
