export interface ReaderProgressPersistenceState {
  activeContent: string | null;
  chapterId: number | null | undefined;
  isDownloaded: boolean;
  requestedChapterId: number;
  storedContent: string | null;
}

export function isReaderProgressPersistenceReady({
  activeContent,
  chapterId,
  isDownloaded,
  requestedChapterId,
  storedContent,
}: ReaderProgressPersistenceState): boolean {
  return (
    requestedChapterId > 0 &&
    chapterId === requestedChapterId &&
    isDownloaded &&
    storedContent !== null &&
    storedContent.length > 0 &&
    activeContent === storedContent
  );
}

export function getReaderContentPhaseKey(
  chapterId: number,
  persistenceReady: boolean,
): string {
  return `${chapterId}:${persistenceReady ? "stored" : "partial"}`;
}
