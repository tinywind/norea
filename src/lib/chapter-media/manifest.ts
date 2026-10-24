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
  strict = false,
): ChapterMediaManifest {
  if (!raw) return emptyChapterMediaManifest();
  try {
    const parsed = JSON.parse(raw) as Partial<ChapterMediaManifest>;
    const files = Array.isArray(parsed.media?.files) ? parsed.media.files : [];
    if (strict) {
      const names = new Set<string>();
      const urls = new Set<string>();
      if (parsed.version !== 1 || typeof parsed.complete !== "boolean" ||
        !Number.isSafeInteger(parsed.updatedAt) || (parsed.updatedAt ?? -1) < 0 || !Array.isArray(parsed.media?.files) ||
        files.some((file) => {
          if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
            typeof file.fileName !== "string" || !/^[a-zA-Z0-9._-]+$/.test(file.fileName) ||
            file.fileName.startsWith(".") || file.fileName.toLowerCase().endsWith(".part") ||
            file.path !== `media/${file.fileName}` || typeof file.sourceUrl !== "string" ||
            (file.status !== "remote" && file.status !== "stored") ||
            !Number.isSafeInteger(file.updatedAt) || file.updatedAt < 0 ||
            names.has(file.fileName) || urls.has(file.sourceUrl)) return true;
          names.add(file.fileName);
          urls.add(file.sourceUrl);
          return false;
        })) {
        throw new Error("A valid manifest is required to repair chapter media.");
      }
    }
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
  } catch (error) {
    if (strict) throw new Error("Cannot read chapter media repair manifest.", { cause: error });
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
