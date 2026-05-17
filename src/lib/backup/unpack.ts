import { invoke } from "@tauri-apps/api/core";
import {
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  assertByteBudget,
} from "../performance-budgets";
import { parseBackupManifest, type BackupManifest } from "./format";

interface LegacyUnpackedBackupRaw {
  /** Snake-case to match the Rust serde default — see `cf_webview.ts`. */
  manifest_json: string;
  chapters: Array<{ id: number; html: string }>;
  chapter_media?: Array<{ media_src: string; body: number[] }>;
}

interface StagedUnpackedBackupRaw {
  manifest_json: string;
  chapters: Array<{ id: number; html: string }>;
  chapter_media?: Array<{
    bytes: number;
    media_src: string;
    staged_ref: string;
  }>;
  staging_id?: string | null;
}

export interface BackupChapterMediaFile {
  body?: number[];
  bytes: number;
  mediaSrc: string;
  stagedRef?: string;
  stagingId?: string;
}

const BACKUP_CHAPTER_MEDIA_FILES = Symbol("backupChapterMediaFiles");
const LOCAL_CHAPTER_MEDIA_SRC_PATTERN =
  /^norea-media:\/\/chapter\/([1-9]\d*)\/[A-Za-z0-9._-]+$/;

type BackupManifestWithChapterMedia = BackupManifest & {
  [BACKUP_CHAPTER_MEDIA_FILES]?: readonly BackupChapterMediaFile[];
};

export function attachBackupChapterMediaFiles(
  manifest: BackupManifest,
  files: readonly BackupChapterMediaFile[],
): BackupManifest {
  Object.defineProperty(manifest, BACKUP_CHAPTER_MEDIA_FILES, {
    configurable: false,
    enumerable: false,
    value: files,
  });
  return manifest;
}

export function hasBackupChapterMediaFiles(
  manifest: BackupManifest,
): boolean {
  return getBackupChapterMediaFiles(manifest).length > 0;
}

export function getBackupChapterMediaFiles(
  manifest: BackupManifest,
): readonly BackupChapterMediaFile[] {
  return (
    (manifest as BackupManifestWithChapterMedia)[BACKUP_CHAPTER_MEDIA_FILES] ??
    []
  );
}

function chapterMediaByteCounts(
  files: readonly BackupChapterMediaFile[],
): Map<number, number> {
  const bytesByChapterId = new Map<number, number>();
  for (const file of files) {
    const match = LOCAL_CHAPTER_MEDIA_SRC_PATTERN.exec(file.mediaSrc);
    if (!match) continue;
    const chapterId = Number.parseInt(match[1]!, 10);
    bytesByChapterId.set(
      chapterId,
      (bytesByChapterId.get(chapterId) ?? 0) + file.bytes,
    );
  }
  return bytesByChapterId;
}

function parseLegacyChapterMediaFiles(
  files: readonly { media_src: string; body: number[] }[],
): BackupChapterMediaFile[] {
  let totalBytes = 0;
  return files.map((file) => {
    assertByteBudget(
      file.body.length,
      MAX_ZIP_ENTRY_BYTES,
      "Backup media entry",
    );
    totalBytes += file.body.length;
    assertByteBudget(
      totalBytes,
      MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
      "Backup media total",
    );
    return {
      body: file.body,
      bytes: file.body.length,
      mediaSrc: file.media_src,
    };
  });
}

function parseStagedChapterMediaFiles(
  files: readonly {
    bytes: number;
    media_src: string;
    staged_ref: string;
  }[],
  stagingId: string | null | undefined,
): BackupChapterMediaFile[] {
  if (files.length === 0) return [];
  if (!stagingId || stagingId.trim() === "") {
    throw new Error("Backup media staging id is missing.");
  }
  let totalBytes = 0;
  return files.map((file) => {
    assertByteBudget(
      file.bytes,
      MAX_ZIP_ENTRY_BYTES,
      "Backup media entry",
    );
    totalBytes += file.bytes;
    assertByteBudget(
      totalBytes,
      MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
      "Backup media total",
    );
    if (!file.staged_ref || file.staged_ref.trim() === "") {
      throw new Error("Backup media staged reference is missing.");
    }
    return {
      bytes: file.bytes,
      mediaSrc: file.media_src,
      stagedRef: file.staged_ref,
      stagingId,
    };
  });
}

function isLegacyBackupUnpackFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown command|command .*not found|not found.*command|not registered/i.test(
    message,
  );
}

export function isStagedBackupChapterMediaFile(
  file: BackupChapterMediaFile,
): file is BackupChapterMediaFile & {
  stagedRef: string;
  stagingId: string;
} {
  return (
    file.stagedRef !== undefined &&
    file.stagedRef.trim() !== "" &&
    file.stagingId !== undefined &&
    file.stagingId.trim() !== ""
  );
}

export function isLegacyBackupChapterMediaFile(
  file: BackupChapterMediaFile,
): file is BackupChapterMediaFile & { body: number[] } {
  return Array.isArray(file.body);
}

export function getBackupChapterMediaStagingIds(
  manifest: BackupManifest,
): string[] {
  return [
    ...new Set(
      getBackupChapterMediaFiles(manifest)
        .map((file) => file.stagingId)
        .filter((stagingId): stagingId is string => !!stagingId),
    ),
  ];
}

export async function cleanupBackupStagedUnpack(
  stagingId: string,
): Promise<void> {
  if (stagingId.trim() === "") return;
  await invoke("backup_cleanup_staged_unpack", { stagingId });
}

async function cleanupRawStagedUnpack(
  result: StagedUnpackedBackupRaw,
): Promise<void> {
  if (!result.staging_id) return;
  await cleanupBackupStagedUnpack(result.staging_id).catch((error) => {
    console.warn("[backup] staged unpack cleanup failed", error);
  });
}

/**
 * Read a backup zip from disk via the Rust staged unpack IPC command.
 * Re-injects each `chapters/<id>.html` body into the matching chapter
 * row's `content` field on the parsed manifest.
 *
 * Throws `BackupFormatError` (re-exported from `./format`) if the
 * envelope JSON is malformed.
 */
export async function unpackBackup(inputPath: string): Promise<BackupManifest> {
  let stagedResult: StagedUnpackedBackupRaw | null = null;
  try {
    stagedResult = await invoke<StagedUnpackedBackupRaw>(
      "backup_unpack_staged",
      { inputPath },
    );
  } catch (error) {
    if (!isLegacyBackupUnpackFallbackError(error)) throw error;
    const result = await invoke<LegacyUnpackedBackupRaw>("backup_unpack", {
      inputPath,
    });
    return parseLegacyUnpackedBackup(result);
  }
  if (!stagedResult) {
    throw new Error("Backup staged unpack returned no result.");
  }
  try {
    return parseStagedUnpackedBackup(stagedResult);
  } catch (error) {
    await cleanupRawStagedUnpack(stagedResult);
    throw error;
  }
}

export async function unpackBackupBytes(body: number[]): Promise<BackupManifest> {
  assertByteBudget(body.length, MAX_BACKUP_ARCHIVE_BYTES, "Backup archive");
  let stagedResult: StagedUnpackedBackupRaw | null = null;
  try {
    stagedResult = await invoke<StagedUnpackedBackupRaw>(
      "backup_unpack_bytes_staged",
      { body },
    );
  } catch (error) {
    if (!isLegacyBackupUnpackFallbackError(error)) throw error;
    const result = await invoke<LegacyUnpackedBackupRaw>(
      "backup_unpack_bytes",
      { body },
    );
    return parseLegacyUnpackedBackup(result);
  }
  if (!stagedResult) {
    throw new Error("Backup staged unpack returned no result.");
  }
  try {
    return parseStagedUnpackedBackup(stagedResult);
  } catch (error) {
    await cleanupRawStagedUnpack(stagedResult);
    throw error;
  }
}

function parseLegacyUnpackedBackup(
  result: LegacyUnpackedBackupRaw,
): BackupManifest {
  return parseUnpackedBackup(
    result,
    parseLegacyChapterMediaFiles(result.chapter_media ?? []),
  );
}

function parseStagedUnpackedBackup(
  result: StagedUnpackedBackupRaw,
): BackupManifest {
  return parseUnpackedBackup(
    result,
    parseStagedChapterMediaFiles(
      result.chapter_media ?? [],
      result.staging_id,
    ),
  );
}

function parseUnpackedBackup(
  result: Pick<LegacyUnpackedBackupRaw, "chapters" | "manifest_json">,
  chapterMediaFiles: BackupChapterMediaFile[],
): BackupManifest {
  const manifest = parseBackupManifest(result.manifest_json);
  const htmlById = new Map<number, string>();
  for (const entry of result.chapters) {
    htmlById.set(entry.id, entry.html);
  }
  const mediaBytesByChapterId = chapterMediaByteCounts(chapterMediaFiles);
  const restored = {
    ...manifest,
    chapters: manifest.chapters.map((chapter) => {
      const html = htmlById.get(chapter.id);
      const mediaBytes = mediaBytesByChapterId.get(chapter.id);
      return html !== undefined || mediaBytes !== undefined
        ? {
            ...chapter,
            ...(html !== undefined ? { content: html } : {}),
            ...(mediaBytes !== undefined ? { mediaBytes } : {}),
          }
        : chapter;
    }),
  };
  return attachBackupChapterMediaFiles(restored, chapterMediaFiles);
}
