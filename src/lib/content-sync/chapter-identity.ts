const FOLDER_CHAPTER_PATH = /^norea-folder:(\d+(?:\.\d+)?)$/;
const NUMERIC_CHAPTER = /^\d+(?:\.\d+)?$/;

interface ChapterIdentityCandidate {
  chapterPath: string;
  chapterNumber: string | null | undefined;
}

function chapterNumberOf(candidate: ChapterIdentityCandidate): number | undefined {
  const number = candidate.chapterNumber != null && NUMERIC_CHAPTER.test(candidate.chapterNumber)
    ? candidate.chapterNumber
    : FOLDER_CHAPTER_PATH.exec(candidate.chapterPath)?.[1];
  return number === undefined ? undefined : Number(number);
}

/**
 * Whether a server catalog entry is the requested local chapter. A chapter number proves
 * identity only for a recovered folder chapter whose source path is unknown; two different
 * source paths remain different chapters even when a number lookup returned one for the other.
 */
export function isSameServerChapter(remote: ChapterIdentityCandidate, local: ChapterIdentityCandidate): boolean {
  if (remote.chapterPath === local.chapterPath) return true;
  if (!FOLDER_CHAPTER_PATH.test(remote.chapterPath) && !FOLDER_CHAPTER_PATH.test(local.chapterPath)) return false;
  const remoteNumber = chapterNumberOf(remote);
  return remoteNumber !== undefined && remoteNumber === chapterNumberOf(local);
}

/** A server number lookup returned another source chapter stored under the requested number. */
export function isOtherServerChapterUnderNumber(remote: ChapterIdentityCandidate, local: ChapterIdentityCandidate): boolean {
  const remoteNumber = chapterNumberOf(remote);
  return !isSameServerChapter(remote, local) && remoteNumber !== undefined && remoteNumber === chapterNumberOf(local);
}
