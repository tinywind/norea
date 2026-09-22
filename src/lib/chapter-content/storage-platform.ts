import { invoke } from "@tauri-apps/api/core";
import {
  deleteAndroidStoragePath,
  inspectAndroidChapterArtifacts,
  readAndroidStorageText,
  renameAndroidStoragePath,
  writeAndroidStorageText,
} from "../android-storage";
import type { ChapterContentType } from "../chapter-content";
import {
  chapterContentRelativePath as buildChapterContentRelativePath,
  chapterStorageRelativeDir,
  type ChapterStorageChapterPathInput,
  type ChapterStorageNovelPathInput,
} from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";
import { isAndroidRuntime } from "../tauri-runtime";

export interface ChapterContentStorageIdentity {
  novel: ChapterStorageNovelPathInput & { id: number; pluginId: string };
  chapter: ChapterStorageChapterPathInput & {
    id: number;
    contentType: ChapterContentType;
  };
}

export interface StoredChapterArtifactsInspection {
  status: "missing" | "present";
  contentFile: string | null;
  contentBytes: number;
  mediaBytes: number;
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
  if (isAndroidRuntime()) {
    return readAndroidStorageText(contentFile);
  }
  return invoke<string | null>("chapter_content_mirror_read_file", {
    contentFile,
  });
}

export async function inspectChapterContentArtifacts(
  input: Parameters<typeof inspectAndroidChapterArtifacts>[0],
): Promise<StoredChapterArtifactsInspection> {
  return isAndroidRuntime()
    ? inspectAndroidChapterArtifacts(input)
    : invoke<StoredChapterArtifactsInspection>(
        "chapter_content_mirror_inspect",
        { ...input },
      );
}

export async function writeChapterContentFile(
  chapterId: number,
  content: string,
  metadata: ChapterContentStorageIdentity,
): Promise<void> {
  if (isAndroidRuntime()) {
    const preferredContentPath = chapterContentRelativePath(
      metadata.novel,
      metadata.chapter,
    );
    const contentFileName =
      preferredContentPath.split("/").at(-1) ?? "content.html";
    const preferredChapterDir = chapterStorageRelativeDir(
      metadata.novel,
      metadata.chapter,
    );
    const chapterDir =
      resolvedChapterStorageDir(chapterId) ?? preferredChapterDir;
    const contentPath = `${chapterDir}/${contentFileName}`;
    const tempPath = `${contentPath}.tmp`;
    await writeAndroidStorageText(tempPath, content);
    await renameAndroidStoragePath(tempPath, contentFileName);
    await Promise.all(
      ["content.html", "content.pdf"]
        .filter((fileName) => fileName !== contentFileName)
        .map((fileName) =>
          deleteAndroidStoragePath(`${chapterDir}/${fileName}`),
        ),
    );
    await deleteAndroidStoragePath(
      `${chapterDir}/${CHAPTER_PARTIAL_CONTENT_FILE}`,
    );
    if (chapterDir !== preferredChapterDir) {
      await deleteAndroidStoragePath(
        chapterPartialContentRelativePath(metadata.novel, metadata.chapter),
      );
    }
    return;
  }

  await invoke("chapter_content_mirror_store", {
    chapterId,
    content,
    metadata,
  });
}
export async function writeChapterPartialContentFile(
  content: string,
  metadata: ChapterContentStorageIdentity,
): Promise<void> {
  if (isAndroidRuntime()) {
    await writeAndroidStorageText(
      chapterPartialContentRelativePath(metadata.novel, metadata.chapter),
      content,
    );
    return;
  }
  await invoke("chapter_content_mirror_store_partial", {
    content,
    metadata,
  });
}
export async function clearChapterContentFiles(
  chapterId: number,
  loadIdentity: () =>
    | ChapterContentStorageIdentity
    | null
    | Promise<ChapterContentStorageIdentity | null>,
): Promise<void> {
  if (isAndroidRuntime()) {
    const identity = await loadIdentity();
    if (!identity) return;
    await deleteAndroidStoragePath(
      chapterContentRelativePath(identity.novel, identity.chapter),
    );
    await deleteAndroidStoragePath(
      chapterPartialContentRelativePath(identity.novel, identity.chapter),
    );
    return;
  }
  await invoke("chapter_content_mirror_clear", { chapterId });
}
