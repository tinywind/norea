import type Database from "@tauri-apps/plugin-sql";
import { storedNovelMetadataFingerprint } from "../../db/work-metadata";
import { bytesToBase64 } from "../base64";
import { chapterStorageDirectoryName } from "../chapter-storage-path";
import { listStoredNovelChapters, listStoredNovelMetadata, readStoredNovelCover, type StoredNovelChapter } from "../work-metadata";
import type { BackupChapter, BackupManifest, BackupNovel } from "./format";

interface CachedChapterDirectory {
  pluginId: string; novelPath: string; chapterPath: string; directory: string;
  storedContentType: string | null; contentBytes: number; mediaBytes: number;
}
interface RestoredMetadataFile { pluginId: string; path: string; novelId: number; directory: string; fingerprint: string }
interface RestoredChapterDirectory { chapterId: number; novelId: number; directory: string }
export interface BackupRestorePlan {
  manifest: BackupManifest & { novels: (BackupNovel & { rating?: number | null })[] };
  cache: { files: RestoredMetadataFile[]; chapters: RestoredChapterDirectory[] };
}

const identityKey = (pluginId: string, path: string) => JSON.stringify([pluginId, path]);
const chapterKey = (pluginId: string, novelPath: string, path: string) => JSON.stringify([pluginId, novelPath, path]);
const chapterNumber = (chapter: BackupChapter) => Number(chapter.chapterNumber ?? chapter.position);

/** Read original files before the native transaction; restoring never publishes files. */
export async function prepareBackupRestore(db: Database, snapshot: BackupManifest): Promise<BackupRestorePlan> {
  const entries = await listStoredNovelMetadata();
  const cached = await db.select<CachedChapterDirectory[]>(`SELECT n.plugin_id AS pluginId,n.path AS novelPath,c.path AS chapterPath,d.directory,
    c.stored_content_type AS storedContentType,c.content_bytes AS contentBytes,c.media_bytes AS mediaBytes
    FROM work_metadata_directory_cache d JOIN chapter c ON c.id=d.chapter_id JOIN novel n ON n.id=c.novel_id`);
  const directories = new Map(cached.map(row => [chapterKey(row.pluginId, row.novelPath, row.chapterPath), row.directory]));
  const cachedByDirectory = new Map(cached.map(row => [chapterKey(row.pluginId, row.novelPath, row.directory), row]));
  const plan: BackupRestorePlan = {
    manifest: { ...snapshot, novels: snapshot.novels.map(novel => ({ ...novel })), chapters: snapshot.chapters.map(chapter => ({
      ...chapter, isDownloaded: false, contentBytes: 0, mediaBytes: 0,
    })) },
    cache: { files: [], chapters: [] },
  };
  const byIdentity = new Map(plan.manifest.novels.map(novel => [identityKey(novel.pluginId, novel.path), novel]));
  let nextNovelId = plan.manifest.novels.reduce((highest, novel) => Math.max(highest, novel.id), 0) + 1;
  let nextChapterId = plan.manifest.chapters.reduce((highest, chapter) => Math.max(highest, chapter.id), 0) + 1;
  const chaptersByNovel = new Map<number, BackupChapter[]>();
  for (const chapter of plan.manifest.chapters) {
    const chapters = chaptersByNovel.get(chapter.novelId) ?? [];
    chapters.push(chapter); chaptersByNovel.set(chapter.novelId, chapters);
  }
  const now = Math.floor(Date.now() / 1000);
  for (const { directory, metadata } of entries) {
    const { pluginId, novelPath } = metadata.identity;
    let novel = byIdentity.get(identityKey(pluginId, novelPath));
    if (!novel) {
      novel = { id: nextNovelId++, pluginId, sourceNovelId: metadata.identity.novelId, path: novelPath, name: metadata.novel.name, cover: null,
        summary: null, author: null, artist: null, status: null, genres: null, inLibrary: false, isLocal: metadata.novel.isLocal,
        createdAt: now, updatedAt: now, libraryAddedAt: null, lastReadAt: null };
      plan.manifest.novels.push(novel);
      byIdentity.set(identityKey(pluginId, novelPath), novel);
    }
    // A restored data URL must not later overwrite the retained cover file.
    const cover = await readStoredNovelCover(directory, metadata);
    Object.assign(novel, metadata.novel, { sourceNovelId: metadata.identity.novelId, cover: cover && metadata.cover
      ? `data:${metadata.cover.contentType};base64,${bytesToBase64(cover)}` : null });
    const chapters = chaptersByNovel.get(novel.id) ?? [];
    chaptersByNovel.set(novel.id, chapters);
    const byPath = new Map(chapters.map(chapter => [chapter.path, chapter]));
    const byDirectory = new Map(chapters.flatMap(chapter => {
      const stored = directories.get(chapterKey(pluginId, novelPath, chapter.path));
      return stored ? [[stored, chapter] as const] : [];
    }));
    const addChapter = (path: string, name: string, number: string, position: number, type: "html" | "pdf" = "html") => {
      const chapter: BackupChapter = { id: nextChapterId++, novelId: novel!.id, path, name, chapterNumber: number, position,
        page: "1", bookmark: false, unread: true, progress: 0, isDownloaded: false, sourceContentType: type, contentType: type,
        content: null, contentBytes: 0, mediaBytes: 0, releaseTime: null, readAt: null, createdAt: null, foundAt: 0, updatedAt: now };
      chapters.push(chapter); plan.manifest.chapters.push(chapter);
      byPath.set(path, chapter);
      return chapter;
    };
    const byNumber = new Map<number, BackupChapter[]>();
    const indexChapter = (chapter: BackupChapter) => {
      const number = chapterNumber(chapter);
      byNumber.set(number, [...(byNumber.get(number) ?? []), chapter]);
    };
    for (const chapter of chapters) indexChapter(chapter);
    for (const [index, [number, name]] of Object.entries(metadata.chapters).sort(([a], [b]) => Number(a) - Number(b)).entries()) {
      const matches = byNumber.get(Number(number)) ?? [];
      if (matches.length === 1) { matches[0]!.name = name; matches[0]!.position = index + 1; }
      if (matches.length === 0) indexChapter(addChapter(`${metadata.novel.isLocal ? "local-folder" : "norea-folder"}:${number}`, name, number, index + 1));
    }
    const storedChapters = await listStoredNovelChapters(directory);
    const storedCounts = new Map<number, number>();
    for (const chapter of storedChapters) storedCounts.set(Number(chapter.chapterNumber), (storedCounts.get(Number(chapter.chapterNumber)) ?? 0) + 1);
    const used = new Set<number>();
    for (const stored of storedChapters) {
      const absoluteDirectory = `${directory}/${stored.directory}`;
      const recoveredPath = metadata.novel.isLocal ? `local-folder:${stored.directory}` : `norea-folder:${stored.chapterNumber}`;
      const exact = byDirectory.get(absoluteDirectory) ?? byPath.get(recoveredPath);
      const numbered = byNumber.get(Number(stored.chapterNumber)) ?? [];
      const candidates = metadata.novel.isLocal ? numbered.filter(chapter => localDirectoryMatches(chapter, stored)) : numbered;
      let chapter = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
      if ((chapter && used.has(chapter.id)) || (!exact && (candidates.length > 1 || (!metadata.novel.isLocal && storedCounts.get(Number(stored.chapterNumber))! > 1)))) continue;
      if (!chapter) {
        const original = cachedByDirectory.get(chapterKey(pluginId, novelPath, absoluteDirectory));
        chapter = addChapter(original?.chapterPath ?? recoveredPath, metadata.chapters[stored.chapterNumber] ?? stored.name, stored.chapterNumber, chapters.length + 1, stored.contentType);
        indexChapter(chapter);
      }
      chapter.isDownloaded = true;
      chapter.contentType = stored.contentType;
      const original = cachedByDirectory.get(chapterKey(pluginId, novelPath, absoluteDirectory));
      if (original?.storedContentType === stored.contentType) {
        chapter.contentBytes = Math.max(0, original.contentBytes);
        chapter.mediaBytes = Math.max(0, original.mediaBytes);
      }
      used.add(chapter.id);
      plan.cache.chapters.push({ chapterId: chapter.id, novelId: novel.id, directory: absoluteDirectory });
    }
    plan.cache.files.push({ pluginId, path: novelPath, novelId: novel.id, directory, fingerprint: await storedNovelMetadataFingerprint(metadata) });
  }
  return plan;
}

function localDirectoryMatches(chapter: BackupChapter, stored: StoredNovelChapter): boolean {
  return chapterStorageDirectoryName(chapter) === stored.directory;
}
