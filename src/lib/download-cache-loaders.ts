import {
  listDownloadCacheChapters,
  listDownloadCacheNovels,
} from "../db/queries/download-cache";

export function loadDownloadCacheNovels() {
  return listDownloadCacheNovels();
}

export function loadDownloadCacheChapters(novelId: number) {
  return listDownloadCacheChapters(novelId);
}
