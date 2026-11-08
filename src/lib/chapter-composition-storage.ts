import type { ChapterCompositionEntry, ChapterCompositionV1, ChapterSourceSnapshot } from "./chapter-composition";
import type { ChapterStorageTransferPreparedEntry } from "./chapter-storage-transfer";
import { novelStorageRelativeDir } from "./chapter-storage-path";
import { canonicalChapterNumber } from "./source-chapter-renumber";
import { isTauriRuntime } from "./tauri-runtime";

/** Created only from a compiled merge entry and its validated native preparation result. */
export interface ChapterCompositionPreparedCopy {
  entry: ChapterCompositionEntry;
  transfer: ChapterStorageTransferPreparedEntry;
}

function sameSource(left: ChapterSourceSnapshot, right: ChapterSourceSnapshot): boolean {
  return left.pluginId === right.pluginId && left.novelId === right.novelId &&
    (left.sourceChapterId && right.sourceChapterId
      ? left.sourceChapterId === right.sourceChapterId : left.chapterPath === right.chapterPath);
}

function sameOwner(previous: ChapterCompositionEntry | undefined, entry: ChapterCompositionEntry): boolean {
  return Boolean(previous && previous.id === entry.id && previous.path === entry.path &&
    previous.storageChapterNumber === entry.storageChapterNumber &&
    sameSource(previous.sources[previous.primarySource], entry.sources[entry.primarySource]));
}

/** Read the original work file before the caller publishes its new composition. */
export async function assertChapterCompositionStorageOwnership(input: {
  novel: { id: number; pluginId: string; sourceNovelId: string | null; path: string };
  composition: ChapterCompositionV1;
  previousComposition: ChapterCompositionV1 | null;
  existing: readonly { path: string; chapterNumber: string | null; position: number }[];
  preparedCopies?: readonly ChapterCompositionPreparedCopy[];
}): Promise<void> {
  if (!isTauriRuntime()) return;
  const { readStoredNovelMetadata, workMetadataOperation } = await import("./work-metadata");
  const directory = novelStorageRelativeDir(input.novel);
  const { paths = [] } = await workMetadataOperation({ operation: "chapters", path: `${directory}/novel.json` });
  const occupied = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(`${directory}/`)) throw new Error("Chapter composition: invalid stored chapter location");
    const parts = path.slice(directory.length + 1).split("/");
    if (parts.length !== 2 || !["content.html", "content.pdf", ".chapter-content.partial"].includes(parts[1])) {
      throw new Error("Chapter composition: invalid stored chapter file");
    }
    const number = canonicalChapterNumber(parts[0]);
    if (number === parts[0]) occupied.add(number);
  }
  if (!input.composition.entries.some(entry => occupied.has(entry.storageChapterNumber))) return;
  const stored = await readStoredNovelMetadata(directory);
  if (stored && (stored.metadata.identity.pluginId !== input.novel.pluginId ||
    stored.metadata.identity.novelId !== input.novel.sourceNovelId || stored.metadata.identity.novelPath !== input.novel.path)) {
    throw new Error("Chapter composition: stored work identity changed; existing files were retained");
  }
  const storedOwners = new Map(stored?.metadata.chapterComposition?.entries.map(entry => [entry.storageChapterNumber, entry]) ?? []);
  const previousOwners = new Map(input.previousComposition?.entries.map(entry => [entry.storageChapterNumber, entry]) ?? []);
  const existingByPath = new Map(input.existing.map(chapter => [chapter.path, chapter]));
  const copies = new Map(input.preparedCopies?.map(copy => [copy.entry.path, copy]) ?? []);
  for (const entry of input.composition.entries) {
    if (!occupied.has(entry.storageChapterNumber)) continue;
    const storedOwner = storedOwners.get(entry.storageChapterNumber);
    const previousOwner = previousOwners.get(entry.storageChapterNumber);
    const chapter = existingByPath.get(entry.path);
    const source = entry.sources[entry.primarySource];
    const originalRow = chapter && !/^(?:(?:norea|local)-folder|norea-composed|norea-source):/.test(chapter.path) &&
      canonicalChapterNumber(chapter.chapterNumber ?? chapter.position) === entry.storageChapterNumber &&
      source.pluginId === input.novel.pluginId && source.novelId === input.novel.sourceNovelId && source.chapterPath === chapter.path;
    const copy = copies.get(entry.path);
    const targetDirectory = `${directory}/${entry.storageChapterNumber}`;
    const preparedCopy = copy && sameOwner(copy.entry, entry) && copy.transfer.outcome === "copiedSource" &&
      !copy.transfer.replacedTarget && copy.transfer.targetRelativeDir === targetDirectory &&
      ["content.html", "content.pdf"].some(file => copy.transfer.contentFile === `${targetDirectory}/${file}`);
    if ((storedOwner && !sameOwner(storedOwner, entry)) || (previousOwner && !sameOwner(previousOwner, entry)) ||
      !(sameOwner(storedOwner, entry) || sameOwner(previousOwner, entry) || originalRow || preparedCopy)) {
      throw new Error("Chapter composition: existing chapter files have no matching source ownership; existing files were retained");
    }
  }
}
