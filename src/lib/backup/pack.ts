import { invoke } from "@tauri-apps/api/core";
import {
  localChapterMediaSources,
  type ChapterMediaStorageContext,
} from "../chapter-media";
import { encodeBackupManifest, type BackupManifest } from "./format";

interface BackupChapterMediaFilePayload {
  media_src: string;
  novel_id?: number | null;
  source_id?: string | null;
  novel_name?: string | null;
  novel_path?: string | null;
  chapter_number?: string | null;
  chapter_name?: string | null;
  chapter_position?: number | null;
}

interface BackupChapterMediaSource {
  context: ChapterMediaStorageContext;
  mediaSrc: string;
}

function backupChapterMediaSources(
  manifest: BackupManifest,
): BackupChapterMediaSource[] {
  const mediaSources = new Map<string, BackupChapterMediaSource>();
  const novelsById = new Map(manifest.novels.map((novel) => [novel.id, novel]));
  for (const chapter of manifest.chapters) {
    if (!chapter.content) continue;
    const novel = novelsById.get(chapter.novelId);
    const context: ChapterMediaStorageContext = {
      chapterId: chapter.id,
      chapterName: chapter.name,
      chapterNumber: chapter.chapterNumber,
      chapterPosition: chapter.position,
      novelId: chapter.novelId,
      novelName: novel?.name,
      novelPath: novel?.path,
      sourceId: novel?.pluginId,
    };
    for (const mediaSrc of localChapterMediaSources(chapter.content, context)) {
      if (!mediaSources.has(mediaSrc)) {
        mediaSources.set(mediaSrc, { context, mediaSrc });
      }
    }
  }
  return [...mediaSources.values()];
}

function backupChapterMediaFilePayloads(
  manifest: BackupManifest,
): BackupChapterMediaFilePayload[] {
  return backupChapterMediaSources(manifest).map((source) => ({
      media_src: source.mediaSrc,
      novel_id: source.context.novelId,
      source_id: source.context.sourceId,
      novel_name: source.context.novelName,
      novel_path: source.context.novelPath,
      chapter_number: source.context.chapterNumber,
      chapter_name: source.context.chapterName,
      chapter_position: source.context.chapterPosition,
    }));
}

/**
 * Pack a {@link BackupManifest} into a zip on disk via the Rust
 * `backup_pack` IPC command.
 */
export async function packBackup(
  manifest: BackupManifest,
  outputPath: string,
): Promise<void> {
  const chapterMediaFiles = backupChapterMediaFilePayloads(manifest);
  await invoke("backup_pack", {
    chapterMedia: [],
    chapterMediaFiles,
    manifestJson: encodeBackupManifest(manifest),
    outputPath,
  });
}

export async function packBackupTempFile(
  manifest: BackupManifest,
): Promise<string> {
  const chapterMediaFiles = backupChapterMediaFilePayloads(manifest);
  return invoke<string>("backup_pack_temp_file", {
    chapterMedia: [],
    chapterMediaFiles,
    manifestJson: encodeBackupManifest(manifest),
  });
}

export async function deleteBackupTempFile(path: string): Promise<void> {
  await invoke("backup_delete_temp_file", { path });
}

export async function packBackupBytes(
  manifest: BackupManifest,
): Promise<number[]> {
  const chapterMediaFiles = backupChapterMediaFilePayloads(manifest);
  return invoke<number[]>("backup_pack_bytes", {
    chapterMedia: [],
    chapterMediaFiles,
    manifestJson: encodeBackupManifest(manifest),
  });
}
