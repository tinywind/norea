/** Private reading state is separate from shared content and its metadata clocks. */
export interface ReadingStateEntry {
  pluginId: string;
  sourceNovelId: string | null;
  novelPath: string;
  chapterPath: string;
  chapterNumber: string | null;
  page: string;
  unread: boolean;
  progress: number;
  bookmark: boolean;
  readAt: number | null;
}

export type ReadingStateValue = Pick<ReadingStateEntry, "unread" | "progress" | "bookmark" | "readAt">;

export function mergeReadingState(local: ReadingStateValue, remote: ReadingStateValue): ReadingStateValue {
  const progress = Math.max(local.progress, remote.progress);
  return {
    unread: local.unread && remote.unread && progress < 100,
    progress,
    bookmark: local.bookmark || remote.bookmark,
    readAt: local.readAt === null ? remote.readAt
      : remote.readAt === null ? local.readAt : Math.max(local.readAt, remote.readAt),
  };
}

export function sameReadingState(left: ReadingStateValue, right: ReadingStateValue): boolean {
  return left.unread === right.unread && left.progress === right.progress
    && left.bookmark === right.bookmark && left.readAt === right.readAt;
}

function boundedString(value: unknown, max: number, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === "string" && value.trim().length > 0 && value.length <= max);
}

export function isReadingStateEntry(value: unknown): value is ReadingStateEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return boundedString(entry.pluginId, 200) && boundedString(entry.sourceNovelId, 2048, true)
    && boundedString(entry.novelPath, 16384) && boundedString(entry.chapterPath, 16384)
    && boundedString(entry.chapterNumber, 200, true) && boundedString(entry.page, 200)
    && typeof entry.unread === "boolean" && typeof entry.bookmark === "boolean"
    && typeof entry.progress === "number" && Number.isFinite(entry.progress) && entry.progress >= 0 && entry.progress <= 100
    && (entry.readAt === null || (typeof entry.readAt === "number" && Number.isSafeInteger(entry.readAt) && entry.readAt >= 0));
}
