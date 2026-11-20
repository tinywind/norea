import { invoke } from "@tauri-apps/api/core";
import type { ChapterContentType } from "../chapter-content";
import type { ChapterPayloadSnapshot } from "./inventory";
import {
  chapterContentRelativePath as buildChapterContentRelativePath,
  chapterStorageRelativeDir,
  type ChapterStorageChapterPathInput,
  type ChapterStorageNovelPathInput,
} from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";

export interface ChapterContentStorageIdentity {
  novel: ChapterStorageNovelPathInput & { id: number; pluginId: string };
  chapter: ChapterStorageChapterPathInput & {
    id: number;
    contentType: ChapterContentType;
  };
}

export interface InspectStoredChapterArtifactsInput {
  preferredChapterDir: string;
  sourceDir: string;
  novelDirectoryName: string;
  chapterDirectoryName: string;
  preferredContentFileName: string;
}

export interface StoredChapterArtifactsInspection {
  status: "missing" | "present";
  contentFile: string | null;
  contentBytes: number;
  mediaBytes: number;
  mediaComplete: boolean;
}

export interface ChapterPayloadDeleteResult {
  snapshot: ChapterPayloadSnapshot;
  errors: { path: string; message: string }[];
}

export interface FastPayloadSnapshot {
  payloadBytes: number;
  contentBytes: number;
  mediaBytes: number;
  mediaComplete: boolean;
}

export interface FastPayloadDeleteResult {
  bytesFreed: number;
  snapshot: FastPayloadSnapshot;
  errors: { path: string; message: string }[];
}

function cleanupChapterDir(identity: ChapterContentStorageIdentity): string {
  const canonical = chapterStorageRelativeDir(
    { ...identity.novel, id: undefined },
    { ...identity.chapter, id: undefined },
  );
  const resolved = resolvedChapterStorageDir(identity.chapter.id);
  if (resolved && resolved !== canonical) {
    throw new Error("Stored chapter directory does not match its canonical identity.");
  }
  return canonical;
}

export async function inspectChapterPayloadInventory(
  identity: ChapterContentStorageIdentity,
  signal?: AbortSignal,
): Promise<ChapterPayloadSnapshot> {
  signal?.throwIfAborted();
  const chapterDir = cleanupChapterDir(identity);
  const snapshot = await invoke<ChapterPayloadSnapshot>("chapter_payload_inventory", {
    chapterDir,
  });
  signal?.throwIfAborted();
  return snapshot;
}

export async function deleteChapterPayload(
  identity: ChapterContentStorageIdentity,
  expectedFingerprint: string,
): Promise<ChapterPayloadDeleteResult> {
  const chapterDir = cleanupChapterDir(identity);
  return invoke<ChapterPayloadDeleteResult>("chapter_payload_delete", {
    chapterDir,
    expectedFingerprint,
  });
}

export async function deleteChapterPayloadFast(
  identity: ChapterContentStorageIdentity,
  signal?: AbortSignal,
): Promise<FastPayloadDeleteResult> {
  signal?.throwIfAborted();
  const chapterDir = cleanupChapterDir(identity);
  return invoke<FastPayloadDeleteResult>("chapter_payload_delete_fast", {
    chapterDir,
  });
}

const CHAPTER_PARTIAL_CONTENT_FILE = ".chapter-content.partial";

function chapterContentExtension(contentType: string | undefined): string {
  if (contentType === "pdf") return "pdf";
  if (contentType === "markdown") return "html";
  if (contentType === "epub") return "html";
  return "html";
}

export function chapterContentRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput & { contentType?: string },
): string {
  const extension = chapterContentExtension(chapter.contentType);
  return buildChapterContentRelativePath(novel, chapter, extension);
}

export function chapterPartialContentRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
): string {
  return `${chapterStorageRelativeDir(novel, chapter)}/${CHAPTER_PARTIAL_CONTENT_FILE}`;
}

export async function readStoredChapterContentFile(
  contentFile: string,
): Promise<string | null> {
  return invoke<string | null>("chapter_content_mirror_read_file", {
    contentFile,
  });
}

export async function inspectChapterContentArtifacts(
  input: InspectStoredChapterArtifactsInput,
): Promise<StoredChapterArtifactsInspection> {
  return invoke<StoredChapterArtifactsInspection>(
    "chapter_content_mirror_inspect",
    { ...input },
  );
}

export async function writeChapterContentFile(
  chapterId: number,
  content: string,
  metadata: ChapterContentStorageIdentity,
): Promise<void> {
  await invoke("chapter_content_mirror_store", {
    chapterId,
    content,
    metadata: {
      ...metadata,
      storageDir: chapterStorageRelativeDir(metadata.novel, metadata.chapter),
    },
  });
}

export async function writeChapterPartialContentFile(
  content: string,
  metadata: ChapterContentStorageIdentity,
): Promise<void> {
  await invoke("chapter_content_mirror_store_partial", {
    content,
    metadata: {
      ...metadata,
      storageDir: chapterStorageRelativeDir(metadata.novel, metadata.chapter),
    },
  });
}

export async function clearChapterContentFiles(
  chapterId: number,
  loadIdentity: () =>
    | ChapterContentStorageIdentity
    | null
    | Promise<ChapterContentStorageIdentity | null>,
): Promise<void> {
  const identity = await loadIdentity();
  if (!identity) return;
  await invoke("chapter_content_mirror_clear", {
    chapterDir:
      resolvedChapterStorageDir(chapterId) ??
      chapterStorageRelativeDir(identity.novel, identity.chapter),
  });
}
