import type { ChapterContentType } from "./chapter-content";
import { isStorageId } from "./storage-id";

/** The upstream values are retained independently of the user's final chapter list. */
export interface ChapterSourceSnapshot {
  pluginId: string;
  novelId: string;
  novelPath: string;
  chapterPath: string;
  sourceChapterId?: string;
  chapterNumber: string | null;
  name: string;
  position: number;
  page: string;
  contentType: ChapterContentType;
  releaseTime: string | null;
}

export interface ChapterCompositionEntry {
  id: string;
  /** Stable target-local identity, independent of displayed order and source numbering. */
  path: string;
  /** Immutable numeric directory key. Reordering must never rename stored chapter data. */
  storageChapterNumber: string;
  sources: ChapterSourceSnapshot[];
  primarySource: number;
  user: {
    included: boolean;
    order: number;
    name: string | null;
    chapterNumber: string | null;
  };
}

export interface ChapterCompositionV1 {
  version: 1;
  updatedAt: number;
  /** Includes excluded entries so a later source refresh cannot resurrect them. */
  entries: ChapterCompositionEntry[];
}

const CONTENT_TYPES = new Set(["html", "text", "pdf", "markdown", "epub"]);
const MAX_COMPOSITION_BYTES = 16 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chapter composition: expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 4096 ||
      Array.from(value).some(character => {
        const code = character.codePointAt(0)!;
        return code >= 0xd800 && code <= 0xdfff;
      })) throw new Error("Chapter composition: invalid text");
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Chapter composition: invalid integer");
  return value as number;
}

export function isCompositionStorageNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) && String(Number(value)) === value;
}

function parseSource(raw: unknown): ChapterSourceSnapshot {
  const value = object(raw);
  if (!isStorageId(value.pluginId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.pluginId) ||
      !isStorageId(value.novelId)) throw new Error("Chapter composition: invalid source storage identity");
  const novelPath = text(value.novelPath)!;
  if (/^(?:https?:)?\/\//i.test(novelPath) || novelPath.startsWith("norea-folder:")) {
    throw new Error("Chapter composition: expected a source work path");
  }
  if (!CONTENT_TYPES.has(value.contentType as string)) throw new Error("Chapter composition: invalid source content type");
  return {
    pluginId: value.pluginId,
    novelId: value.novelId,
    novelPath,
    chapterPath: text(value.chapterPath)!,
    ...(value.sourceChapterId === undefined ? {} : { sourceChapterId: text(value.sourceChapterId)! }),
    chapterNumber: text(value.chapterNumber, true),
    name: text(value.name)!,
    position: integer(value.position),
    page: text(value.page)!,
    contentType: value.contentType as ChapterContentType,
    releaseTime: text(value.releaseTime, true),
  };
}

/** Validate imported metadata and return an isolated, canonical supported document. */
export function parseChapterComposition(raw: unknown): ChapterCompositionV1 {
  const value = object(raw);
  if (value.version !== 1) throw new Error("Chapter composition: unsupported version");
  const updatedAt = integer(value.updatedAt);
  if (!Array.isArray(value.entries) || value.entries.length > 100_000) throw new Error("Chapter composition: invalid entries");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_COMPOSITION_BYTES) {
    throw new Error("Chapter composition: document exceeds size limit");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const storageNumbers = new Set<string>();
  const orders = new Set<number>();
  const entries = value.entries.map(rawEntry => {
    const input = object(rawEntry);
    const id = text(input.id)!;
    const path = text(input.path)!;
    if (!isCompositionStorageNumber(input.storageChapterNumber)) throw new Error("Chapter composition: invalid storage chapter number");
    const storageChapterNumber = input.storageChapterNumber;
    if (ids.has(id) || paths.has(path) || storageNumbers.has(storageChapterNumber)) {
      throw new Error("Chapter composition: duplicate entry identity or storage chapter number");
    }
    ids.add(id); paths.add(path); storageNumbers.add(storageChapterNumber);
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 1000) {
      throw new Error("Chapter composition: missing source snapshots");
    }
    const sources = input.sources.map(parseSource);
    const primarySource = integer(input.primarySource);
    if (primarySource >= sources.length) throw new Error("Chapter composition: invalid primary source");
    const inputUser = object(input.user);
    if (typeof inputUser.included !== "boolean") throw new Error("Chapter composition: invalid inclusion flag");
    const order = integer(inputUser.order);
    if (inputUser.included) {
      if (order === 0 || orders.has(order)) throw new Error("Chapter composition: invalid final order");
      orders.add(order);
    }
    return {
      id, path, storageChapterNumber, sources, primarySource,
      user: {
        included: inputUser.included,
        order,
        name: text(inputUser.name, true),
        chapterNumber: text(inputUser.chapterNumber, true),
      },
    };
  });
  for (let order = 1; order <= orders.size; order++) {
    if (!orders.has(order)) throw new Error("Chapter composition: final order must be consecutive");
  }
  return { version: 1, updatedAt, entries };
}

export function includedChapterCompositionEntries(composition: ChapterCompositionV1): ChapterCompositionEntry[] {
  return composition.entries.filter(entry => entry.user.included).sort((a, b) => a.user.order - b.user.order);
}

export function chapterCompositionCatalog(composition: ChapterCompositionV1): Record<string, string> {
  return Object.fromEntries(includedChapterCompositionEntries(composition).map(entry => [
    entry.storageChapterNumber, entry.user.name ?? entry.sources[entry.primarySource].name,
  ]));
}

export function getChapterCompositionDisplay(composition: ChapterCompositionV1, path: string): {
  included: boolean; name: string; chapterNumber: string; position: number;
} | undefined {
  const entry = composition.entries.find(candidate => candidate.path === path);
  if (!entry) return undefined;
  return {
    included: entry.user.included,
    name: entry.user.name ?? entry.sources[entry.primarySource].name,
    chapterNumber: entry.user.chapterNumber ?? String(entry.user.order),
    position: entry.user.order,
  };
}
