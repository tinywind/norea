export const MAX_NOVEL_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_NOVEL_COVER_BYTES = 10 * 1024 * 1024;

export interface NovelMetadataV1 {
  schemaVersion: 1;
  identity: { pluginId: string; novelPath: string };
  novel: {
    name: string;
    cover: string | null;
    author: string | null;
    artist: string | null;
    summary: string | null;
    status: string | null;
    genres: string | null;
    rating: number | null;
    isLocal: boolean;
  };
  cover: { fileName: string; contentType: string | null; sourceUrl: string } | null;
}

export function safeMetadataChild(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value !== "." && value !== ".." &&
    !/[\u0000-\u001f<>:"/\\|?*]/.test(value) && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("work metadata: expected object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !(key in result))) {
    throw new Error("work metadata: unexpected or missing fields");
  }
  return result;
}

function text(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length > (nullable ? MAX_NOVEL_METADATA_BYTES : 4096) || (!nullable && !value.trim()) ||
    Array.from(value).some((character) => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) {
    throw new Error("work metadata: invalid text");
  }
}

export function parseNovelMetadata(raw: unknown): NovelMetadataV1 {
  const value = record(raw, ["schemaVersion", "identity", "novel", "cover"]);
  if (value.schemaVersion !== 1) {
    throw new Error("work metadata: invalid version");
  }
  const identity = record(value.identity, ["pluginId", "novelPath"]);
  text(identity.pluginId); text(identity.novelPath);
  if ((identity.novelPath as string).startsWith("norea-folder:")) throw new Error("work metadata: source work identity required");
  if (/^(?:https?:)?\/\//i.test(identity.novelPath as string)) throw new Error("work metadata: work identity must exclude the base URL");
  const novel = record(value.novel, ["name", "cover", "author", "artist", "summary", "status", "genres", "rating", "isLocal"]);
  text(novel.name);
  for (const key of ["cover", "author", "artist", "summary", "status", "genres"]) text(novel[key], true);
  if (novel.rating !== null && (typeof novel.rating !== "number" || !Number.isFinite(novel.rating) || novel.rating < 0 || novel.rating > 5)) throw new Error("work metadata: invalid rating");
  if (typeof novel.isLocal !== "boolean") throw new Error("work metadata: invalid local flag");
  if (value.cover !== null) {
    const cover = record(value.cover, ["fileName", "contentType", "sourceUrl"]);
    text(cover.fileName); text(cover.sourceUrl); text(cover.contentType, true);
    if (cover.contentType !== null && !/^image\/[a-zA-Z0-9.+-]+$/.test(cover.contentType as string)) throw new Error("work metadata: invalid cover content type");
    if (!/^cover\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(cover.fileName as string)) throw new Error("work metadata: unsafe cover filename");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_NOVEL_METADATA_BYTES) throw new Error("work metadata: document exceeds size limit");
  const parsed = value as unknown as NovelMetadataV1;
  return {
    schemaVersion: 1,
    identity: { pluginId: parsed.identity.pluginId, novelPath: parsed.identity.novelPath },
    novel: {
      name: parsed.novel.name, cover: parsed.novel.cover, author: parsed.novel.author,
      artist: parsed.novel.artist, summary: parsed.novel.summary, status: parsed.novel.status,
      genres: parsed.novel.genres, rating: parsed.novel.rating, isLocal: parsed.novel.isLocal,
    },
    cover: parsed.cover ? { fileName: parsed.cover.fileName, contentType: parsed.cover.contentType, sourceUrl: parsed.cover.sourceUrl } : null,
  };
}
