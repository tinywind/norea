import { isStorageId } from "../storage-id";
import { LOCAL_PLUGIN_ID } from "../plugins/types";

export const MAX_NOVEL_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_NOVEL_COVER_BYTES = 10 * 1024 * 1024;

export interface NovelMetadataV1 {
  schemaVersion: 1;
  identity: { pluginId: string; novelId: string; novelPath: string };
  novel: {
    name: string;
    author: string | null;
    artist: string | null;
    summary: string | null;
    status: string | null;
    genres: string | null;
    rating: number | null;
    isLocal: boolean;
  };
  cover: { fileName: string; contentType: string | null } | null;
  chapters: Record<string, string>;
}

export function safeMetadataChild(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value !== "." && value !== ".." &&
    !/[\u0000-\u001f<>:"/\\|?*]/.test(value) && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("work metadata: expected object");
  return value as Record<string, unknown>;
}

function text(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length > (nullable ? MAX_NOVEL_METADATA_BYTES : 4096) || (!nullable && !value.trim()) ||
    Array.from(value).some((character) => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) {
    throw new Error("work metadata: invalid text");
  }
}

export function parseNovelMetadata(raw: unknown): NovelMetadataV1 {
  const value = record(raw);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw new Error("work metadata: invalid version");
  }
  const identity = record(value.identity);
  text(identity.pluginId); text(identity.novelPath);
  if (!isStorageId(identity.pluginId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.pluginId) || !isStorageId(identity.novelId)) throw new Error("work metadata: invalid plugin or novel ID");
  if ((identity.novelPath as string).startsWith("norea-folder:")) throw new Error("work metadata: source work identity required");
  if (/^(?:https?:)?\/\//i.test(identity.novelPath as string)) throw new Error("work metadata: work identity must exclude the base URL");
  const novel = record(value.novel);
  text(novel.name);
  for (const key of ["author", "artist", "summary", "status", "genres"]) text(novel[key] ?? null, true);
  if (novel.rating != null && (typeof novel.rating !== "number" || !Number.isFinite(novel.rating) || novel.rating < 0 || novel.rating > 5)) throw new Error("work metadata: invalid rating");
  if (novel.isLocal != null && typeof novel.isLocal !== "boolean") throw new Error("work metadata: invalid local flag");
  const chapters: NovelMetadataV1["chapters"] = {};
  if (value.chapters !== undefined) {
    for (const [number, name] of Object.entries(record(value.chapters))) {
      if (!/^\d+(?:\.\d+)?$/.test(number) || !Number.isFinite(Number(number)) || String(Number(number)) !== number) throw new Error("work metadata: invalid chapter number");
      text(name);
      chapters[number] = name as string;
    }
  }
  let cover: NovelMetadataV1["cover"] = null;
  if (value.cover != null) {
    const input = record(value.cover);
    text(input.fileName); text(input.contentType ?? null, true);
    if (input.contentType != null && !/^image\/[a-zA-Z0-9.+-]+$/.test(input.contentType as string)) throw new Error("work metadata: invalid cover content type");
    if (!/^cover\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(input.fileName as string)) throw new Error("work metadata: unsafe cover filename");
    cover = { fileName: input.fileName as string, contentType: input.contentType as string | undefined ?? coverContentType(input.fileName as string) };
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_NOVEL_METADATA_BYTES) throw new Error("work metadata: document exceeds size limit");
  const parsed = value as unknown as NovelMetadataV1;
  return {
    schemaVersion: 1,
    identity: { pluginId: parsed.identity.pluginId, novelId: parsed.identity.novelId, novelPath: parsed.identity.novelPath },
    novel: {
      name: parsed.novel.name, author: parsed.novel.author ?? null,
      artist: parsed.novel.artist ?? null, summary: parsed.novel.summary ?? null, status: parsed.novel.status ?? null,
      genres: parsed.novel.genres ?? null, rating: parsed.novel.rating ?? null, isLocal: parsed.novel.isLocal ?? parsed.identity.pluginId === LOCAL_PLUGIN_ID,
    },
    cover,
    chapters,
  };
}

export function coverContentType(fileName: string): string | null {
  const extension = fileName.split(".").at(-1);
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "svg") return "image/svg+xml";
  return extension && ["avif", "bmp", "gif", "png", "webp"].includes(extension) ? `image/${extension}` : null;
}

export function canonicalMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalMetadataValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, canonicalMetadataValue(entry)]));
  return value;
}
