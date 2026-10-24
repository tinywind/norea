import { getChapterById, listChaptersByNovel, type ChapterListRow } from "../db/queries/chapter";
import { deleteLocalNovelRecords, findLocalDeletionNovel, listStoredDeletionNovelIds } from "../db/queries/content-deletion";
import { getNovelById, setNovelInLibrary, type NovelDetailRecord } from "../db/queries/novel";
import { useContentSyncStore } from "../store/content-sync";
import { useReaderStore } from "../store/reader";
import { forgetNovelStorageDirs } from "./chapter-storage-resolution";
import { novelStorageRelativeDir } from "./chapter-storage-path";
import { removeChapterStorageDirectory } from "./chapter-storage-transfer";
import type { ServerChapterSummary } from "./content-sync/chapters";
import { ContentServerError, contentServerRequest } from "./content-sync/client";
import { registerContentDevice } from "./content-sync/device";
import { setServerChapterDeletionExclusion } from "./content-sync/deletion-exclusions";
import { deleteSelectedServerChapters, deleteServerWork, findServerWork } from "./content-sync/management";
import type { CatalogEntry } from "./content-sync/native";
import type { ServerNovelSource } from "./content-sync/novel-source";
import { runWorkContentStorageOperation } from "./content-sync/storage-operation";
import { runContentSyncOperation } from "./content-sync/sync";
import { recordDeletedWorkMetadata, type WorkCatalogEntry } from "./content-sync/works";
import { describeError } from "./errors";
import { clearNovelCoverDisplayCache } from "./novel-cover-storage";
import { cancelNovelChapterDownloadWork, deleteDownloadCache } from "./tasks/download-cache-delete";

export type ContentDeletionRequest = (
  | { kind: "library"; ids: readonly number[]; serverUrl: string }
  | { kind: "downloads"; scope: "chapter" | "novel" | "all"; ids?: readonly number[]; serverUrl: string }
  | { kind: "server-work"; source: ServerNovelSource }
  | { kind: "server-chapters"; source: ServerNovelSource; chapters: readonly ServerChapterSummary[] }
) & { title: string };
export interface ContentDeletionOptions { local: boolean; server: boolean }
export interface ContentDeletionAction {
  id: string;
  side: "library" | "device" | "server";
  name: string;
  requires?: string;
  source?: ServerNovelSource;
  run: () => Promise<WorkCatalogEntry | void>;
}
export interface ContentDeletionResult {
  id: string;
  status: "succeeded" | "failed";
  error?: string;
  deletedWork?: WorkCatalogEntry;
}

export function matchDeletionChapter<T extends Pick<ChapterListRow, "path" | "chapterNumber">>(rows: readonly T[], target: Pick<ServerChapterSummary, "chapterPath" | "chapterNumber">): T | null {
  const exact = rows.filter(row => row.path === target.chapterPath);
  const number = target.chapterNumber;
  const matches = exact.length ? exact : number != null && /^\d+(?:\.\d+)?$/.test(number)
    ? rows.filter(row => row.chapterNumber != null && /^\d+(?:\.\d+)?$/.test(row.chapterNumber) && Number(row.chapterNumber) === Number(number)) : [];
  if (matches.length > 1) throw new Error("Chapter identity is ambiguous; no chapter was deleted.");
  return matches[0] ?? null;
}

async function deleteLocalDownloads(scope: "chapter" | "novel" | "all", ids: readonly number[], title: string): Promise<void> {
  if (scope !== "all" && !ids.length) return;
  const result = await deleteDownloadCache({ scope, targetIds: ids, title });
  if (result.failed || result.cancelled) throw new Error(`Download deletion did not finish: ${result.deleted}/${result.total} deleted, ${result.failed} failed${result.cancelled ? ", cancelled" : ""}.`);
}

async function deleteMatchingServerChapter(serverUrl: string, novel: NovelDetailRecord, chapter: ChapterListRow): Promise<void> {
  const token = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName);
  const query = new URLSearchParams({ pluginId: novel.pluginId, novelPath: novel.path, chapterPath: chapter.path, includeUnavailable: "true" });
  if (chapter.chapterNumber != null) query.set("chapterNumber", chapter.chapterNumber);
  let entry: CatalogEntry;
  try { entry = await contentServerRequest<CatalogEntry>(serverUrl, `/catalog/chapter?${query}`, token); }
  catch (error) {
    if (!(error instanceof ContentServerError && error.status === 404)) throw error;
    if (novel.sourceNovelId !== null) await setServerChapterDeletionExclusion(serverUrl, {
      pluginId: novel.pluginId, novelId: novel.sourceNovelId, novelPath: novel.path, chapterPath: chapter.path,
    }, chapter.chapterNumber, true);
    return;
  }
  const identity = entry.manifest.identity;
  if (identity.pluginId !== novel.pluginId || identity.novelId !== novel.sourceNovelId || identity.novelPath !== novel.path
    || !matchDeletionChapter([{ path: identity.chapterPath, chapterNumber: entry.manifest.chapter.chapterNumber ?? null }], { chapterPath: chapter.path, chapterNumber: chapter.chapterNumber })) {
    throw new Error("Server chapter identity does not match the selected chapter.");
  }
  if (!entry.deleted) await deleteSelectedServerChapters({ serverUrl }, [entry.id]);
  await setServerChapterDeletionExclusion(serverUrl, identity, entry.manifest.chapter.chapterNumber, true);
}

export async function prepareContentDeletion(request: ContentDeletionRequest, options: ContentDeletionOptions): Promise<ContentDeletionAction[]> {
  const actions: ContentDeletionAction[] = [];
  if (request.kind === "server-work") {
    let deleted: WorkCatalogEntry | undefined;
    let local: { novel: NovelDetailRecord; directory: string; chapterIds: number[] } | null | undefined;
    actions.push({ id: "server-work", side: "server", name: request.title, source: request.source, run: async () => {
      if (deleted) await recordDeletedWorkMetadata(request.source.serverUrl, deleted);
      else deleted = await deleteServerWork(request.source, entry => { deleted = entry; });
      return deleted;
    } });
    if (options.local) actions.push({ id: "local-work", side: "device", name: request.title, requires: "server-work", run: async () => {
      if (local === undefined) {
        const novel = await findLocalDeletionNovel(deleted!.metadata.identity);
        local = novel ? { novel, directory: novelStorageRelativeDir(novel), chapterIds: (await listChaptersByNovel(novel.id)).map(chapter => chapter.id) } : null;
      }
      if (!local) return;
      const { novel, directory, chapterIds } = local;
      await cancelNovelChapterDownloadWork([novel.id]);
      await runWorkContentStorageOperation(novel.pluginId, novel.path, async () => {
        await deleteLocalNovelRecords(novel);
        useReaderStore.getState().removeNovelReaderState(novel.id);
        forgetNovelStorageDirs(novel.id, chapterIds);
        clearNovelCoverDisplayCache(novel.id, { pluginId: novel.pluginId, path: novel.path });
        await removeChapterStorageDirectory(directory);
      });
    } });
    return actions;
  }
  if (request.kind === "server-chapters") {
    // Capture work identity before chapter deletion; a chapter ID is not a local database ID.
    let work: WorkCatalogEntry | undefined;
    const getWork = async () => {
      if (work) return work;
      const token = await registerContentDevice(request.source.serverUrl, useContentSyncStore.getState().deviceName);
      const loaded = await contentServerRequest<WorkCatalogEntry>(request.source.serverUrl, `/works/${encodeURIComponent(request.source.workId)}`, token);
      if (loaded.id !== request.source.workId) throw new Error("Server work identity does not match the selected work.");
      work = loaded;
      return work;
    };
    for (const chapter of new Map(request.chapters.map(row => [row.id, row])).values()) {
      const id = `server:${chapter.id}`;
      actions.push({ id, side: "server", name: chapter.name, run: async () => {
        const identity = (await getWork()).metadata.identity;
        await deleteSelectedServerChapters(request.source, [chapter.id]);
        await setServerChapterDeletionExclusion(request.source.serverUrl, { ...identity, chapterPath: chapter.chapterPath }, chapter.chapterNumber, true);
      } });
      if (options.local) actions.push({ id: `device:${chapter.id}`, side: "device", name: chapter.name, requires: id, run: async () => {
        const novel = await findLocalDeletionNovel((await getWork()).metadata.identity);
        if (!novel) return;
        const localChapter = matchDeletionChapter(await listChaptersByNovel(novel.id), chapter);
        if (localChapter) await deleteLocalDownloads("chapter", [localChapter.id], request.title);
      } });
    }
    return actions;
  }
  if (options.server && !request.serverUrl) throw new Error("No content server is configured.");
  const addServerChapter = (novel: NovelDetailRecord, chapter: ChapterListRow) => {
    actions.push({ id: `server:${chapter.id}`, side: "server", name: `${novel.name} · ${chapter.name}`, run: () => deleteMatchingServerChapter(request.serverUrl, novel, chapter) });
  };
  if (request.kind === "downloads" && request.scope === "chapter") {
    for (const id of new Set(request.ids)) {
      const chapter = await getChapterById(id);
      if (!chapter) continue;
      actions.push({ id: `device:${id}`, side: "device", name: chapter.name, run: () => deleteLocalDownloads("chapter", [id], request.title) });
      if (options.server) {
        const novel = await getNovelById(chapter.novelId);
        if (!novel) throw new Error("Selected chapter's work no longer exists.");
        addServerChapter(novel, chapter);
      }
    }
    return actions;
  }
  const allDownloads = request.kind === "downloads" && request.scope === "all";
  const ids = allDownloads && options.server ? await listStoredDeletionNovelIds() : request.ids;
  if (allDownloads) actions.push({ id: "device:all", side: "device", name: request.title, run: () => deleteLocalDownloads("all", [], request.title) });
  for (const id of new Set(ids)) {
    const novel = await getNovelById(id);
    if (!novel) continue;
    if (request.kind === "library") actions.push({ id: `library:${id}`, side: "library", name: novel.name, run: async () => { await setNovelInLibrary(id, false); } });
    if (!allDownloads && (request.kind === "downloads" || options.local)) actions.push({ id: `device:${id}`, side: "device", name: novel.name, run: () => deleteLocalDownloads("novel", [id], request.title) });
    if (options.server && request.kind === "library") {
      let deleted: WorkCatalogEntry | undefined;
      const action: ContentDeletionAction = { id: `server:${id}`, side: "server", name: novel.name, run: async () => {
        if (deleted) {
          await recordDeletedWorkMetadata(request.serverUrl, deleted);
          return deleted;
        }
        const source = await findServerWork(request.serverUrl, { pluginId: novel.pluginId, novelId: novel.sourceNovelId, novelPath: novel.path });
        if (!source) return;
        action.source = source;
        deleted = await deleteServerWork(source, entry => { deleted = entry; });
        return deleted;
      } };
      actions.push(action);
    } else if (options.server) {
      for (const chapter of await listChaptersByNovel(id)) if (chapter.isDownloaded || chapter.mediaRepairNeeded) addServerChapter(novel, chapter);
    }
  }
  return actions;
}

export function runContentDeletion(actions: readonly ContentDeletionAction[], previous: readonly ContentDeletionResult[] = [], onResult?: (results: ContentDeletionResult[]) => void): Promise<ContentDeletionResult[]> {
  return runContentSyncOperation(async () => {
    const results = new Map(previous.map(result => [result.id, result]));
    let reportedAt = 0;
    for (const action of actions) {
      if (results.get(action.id)?.status === "succeeded") continue;
      if (action.requires && results.get(action.requires)?.status !== "succeeded") {
        results.set(action.id, { id: action.id, status: "failed", error: "Waiting for the server deletion to succeed." });
      } else {
        try {
          const deletedWork = await action.run();
          results.set(action.id, { id: action.id, status: "succeeded", ...(deletedWork ? { deletedWork } : {}) });
        } catch (error) { results.set(action.id, { id: action.id, status: "failed", error: describeError(error) }); }
      }
      if (Date.now() - reportedAt >= 100) { onResult?.([...results.values()]); reportedAt = Date.now(); }
    }
    const completed = [...results.values()];
    onResult?.(completed);
    return completed;
  });
}
