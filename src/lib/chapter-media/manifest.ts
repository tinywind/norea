import {
  type ChapterMediaManifest,
  type ChapterMediaManifestFile,
} from "./types";

export function emptyChapterMediaManifest(): ChapterMediaManifest {
  return {
    complete: false,
    media: {
      files: [],
    },
    updatedAt: 0,
    version: 1,
  };
}

export function parseChapterMediaManifest(
  raw: string | null,
): ChapterMediaManifest {
  if (!raw) return emptyChapterMediaManifest();
  try {
    const parsed = JSON.parse(raw) as Partial<ChapterMediaManifest>;
    const files = Array.isArray(parsed.media?.files) ? parsed.media.files : [];
    return {
      complete: parsed.complete === true,
      media: {
        files: files.filter(
          (file): file is ChapterMediaManifestFile =>
            typeof file === "object" &&
            file !== null &&
            typeof file.bytes === "number" &&
            typeof file.fileName === "string" &&
            typeof file.path === "string" &&
            typeof file.sourceUrl === "string" &&
            (file.status === "remote" || file.status === "stored") &&
            typeof file.updatedAt === "number",
        ),
      },
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      version: 1,
    };
  } catch {
    return emptyChapterMediaManifest();
  }
}

export function serializeChapterMediaManifest(
  files: ChapterMediaManifestFile[],
  complete: boolean,
): string {
  const now = Date.now();
  return `${JSON.stringify(
    {
      complete,
      media: {
        files: [...files].sort((left, right) =>
          left.fileName.localeCompare(right.fileName),
        ),
      },
      updatedAt: now,
      version: 1,
    } satisfies ChapterMediaManifest,
    null,
    2,
  )}\n`;
}
