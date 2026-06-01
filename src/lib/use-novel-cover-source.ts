import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getNovelCoverSnapshot,
  resolveStoredNovelCoverSrc,
  subscribeNovelCoverChanges,
  type NovelCoverStorageInput,
} from "./novel-cover-storage";

export interface NovelCoverSourceInput extends NovelCoverStorageInput {
  cover: string | null;
  isLocal?: boolean | null;
}

export function useNovelCoverSource(novel: NovelCoverSourceInput): string | null {
  const initial = novel.isLocal ? novel.cover?.trim() || null : null;
  const [source, setSource] = useState<string | null>(initial);
  const subscribeToCover = useCallback(
    (onStoreChange: () => void) =>
      subscribeNovelCoverChanges((changedNovelId) => {
        if (changedNovelId === novel.id) onStoreChange();
      }),
    [novel.id],
  );
  const getCoverSnapshot = useCallback(
    () => getNovelCoverSnapshot(novel.id),
    [novel.id],
  );
  const coverSnapshot = useSyncExternalStore(
    subscribeToCover,
    getCoverSnapshot,
    getCoverSnapshot,
  );

  useEffect(() => {
    let cancelled = false;
    const localCover = novel.isLocal ? novel.cover?.trim() || null : null;
    setSource(localCover);

    if (novel.isLocal) return;

    void resolveStoredNovelCoverSrc(novel)
      .then((resolved) => {
        if (!cancelled) setSource(resolved);
      })
      .catch(() => {
        if (!cancelled) setSource(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    coverSnapshot,
    novel.cover,
    novel.id,
    novel.isLocal,
    novel.name,
    novel.path,
    novel.pluginId,
  ]);

  return source;
}
