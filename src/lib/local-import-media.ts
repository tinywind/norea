import { LOCAL_PLUGIN_ID } from "./plugins/types";
import { listChaptersByNovel } from "../db/queries/chapter";
import type { LocalNovelImportChapterInput } from "../db/queries/novel";
import {
  cacheHtmlChapterMedia,
  clearChapterMedia,
  hasRemoteChapterMedia,
  storeEmbeddedChapterMedia,
} from "./chapter-media";
import {
  isHtmlLikeChapterContentType,
  storedChapterContentType,
} from "./chapter-content";
import { saveStoredChapterContent } from "./chapter-content-storage";

interface CacheLocalImportedChapterMediaInput {
  chapters: LocalNovelImportChapterInput[];
  novelId: number;
  novelName: string;
  novelPath: string;
}

export async function cacheLocalImportedChapterMedia({
  chapters,
  novelId,
  novelName,
  novelPath,
}: CacheLocalImportedChapterMediaInput): Promise<void> {
  const cacheableChapters = chapters.filter(
    (chapter) =>
      chapter.binaryResource ||
      isHtmlLikeChapterContentType(
        storedChapterContentType(chapter.contentType ?? "html"),
      ),
  );
  if (cacheableChapters.length === 0) return;

  const rowsByPath = new Map(
    (await listChaptersByNovel(novelId)).map((chapter) => [
      chapter.path,
      chapter,
    ]),
  );

  for (const chapter of cacheableChapters) {
    const row = rowsByPath.get(chapter.path);
    if (!row) continue;
    const contentType = storedChapterContentType(chapter.contentType ?? "html");
    const storageContext = {
      chapterId: row.id,
      chapterName: row.name,
      chapterNumber: row.chapterNumber,
      chapterPosition: row.position,
      novelId,
      novelName,
      novelPath,
      sourceId: LOCAL_PLUGIN_ID,
    };

    let content = chapter.content;
    let mediaBytes = 0;
    if (chapter.binaryResource) {
      const resource = chapter.binaryResource;
      const embedded = await storeEmbeddedChapterMedia({
        chapterId: row.id,
        chapterName: row.name,
        chapterNumber: row.chapterNumber,
        chapterPosition: row.position,
        html: content,
        novelId,
        novelName,
        novelPath,
        resources: [
          {
            bytes: resource.bytes,
            contentType: resource.mediaType,
            fileName: resource.fileName,
            placeholder: resource.locator.placeholder,
            sourcePath: resource.locator.sourcePath,
          },
        ],
        sourceId: LOCAL_PLUGIN_ID,
      });
      await saveStoredChapterContent(row.id, embedded.html, contentType, {
        mediaBytes: embedded.mediaBytes,
      });
      continue;
    }

    const mediaResources = chapter.mediaResources ?? [];
    if (mediaResources.length > 0) {
      const embedded = await storeEmbeddedChapterMedia({
        chapterId: row.id,
        chapterName: row.name,
        chapterNumber: row.chapterNumber,
        chapterPosition: row.position,
        html: content,
        novelId,
        novelName,
        novelPath,
        resources: mediaResources.map((resource) => ({
          bytes: resource.bytes,
          contentType: resource.mediaType,
          fileName: resource.fileName,
          placeholder: resource.placeholder,
          sourcePath: resource.sourcePath,
        })),
        sourceId: LOCAL_PLUGIN_ID,
      });
      content = embedded.html;
      mediaBytes = embedded.mediaBytes;
    }

    if (!hasRemoteChapterMedia(content)) {
      await saveStoredChapterContent(row.id, content, contentType, {
        mediaBytes,
      });
      if (mediaResources.length === 0) {
        await clearChapterMedia(row.id, storageContext);
      }
      continue;
    }

    if (mediaResources.length > 0) {
      await saveStoredChapterContent(row.id, content, contentType, {
        mediaBytes,
      });
      continue;
    }

    const media = await cacheHtmlChapterMedia({
      chapterId: row.id,
      chapterName: row.name,
      chapterNumber: row.chapterNumber ?? String(row.position),
      chapterPosition: row.position,
      html: content,
      novelId,
      novelName,
      novelPath,
      sourceId: LOCAL_PLUGIN_ID,
    });
    await saveStoredChapterContent(row.id, media.html, contentType, {
      mediaBytes: media.mediaBytes,
    });
  }
}
