import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getNovelCoverSnapshot,
  resolveNovelCoverDisplaySource,
  resolveStoredNovelCoverSrc,
  subscribeNovelCoverChanges,
  type NovelCoverDisplaySource,
  type NovelCoverStorageInput,
} from "./novel-cover-storage";
import { pluginManager } from "./plugins/manager";
import type { Plugin } from "./plugins/types";

export interface NovelCoverSourceInput extends NovelCoverStorageInput {
  cover: string | null;
  isLocal?: boolean | null;
}

interface NovelCoverSourceOptions {
  allowSourceFallback?: boolean;
  plugin?: Plugin | null;
}

export function useNovelCoverSource(
  novel: NovelCoverSourceInput,
  options: NovelCoverSourceOptions = {},
): string | null {
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
    let displaySource: NovelCoverDisplaySource | null = null;
    const controller = new AbortController();
    const localCover = novel.isLocal ? novel.cover?.trim() || null : null;
    setSource(localCover);

    if (novel.isLocal || novel.pluginId.trim() === "") return;

    const request = options.allowSourceFallback && options.plugin
      ? resolveNovelCoverDisplaySource(options.plugin, novel, controller.signal)
      : resolveStoredCover();

    async function resolveStoredCover(): Promise<NovelCoverDisplaySource | null> {
      let plugin = options.plugin ?? pluginManager.getPlugin(novel.pluginId);
      if (!plugin) {
        await pluginManager.loadInstalledFromDb().catch(() => undefined);
        plugin = pluginManager.getPlugin(novel.pluginId);
      }
      if (controller.signal.aborted) return null;
      const src = await resolveStoredNovelCoverSrc(novel, plugin);
      return src ? { dispose: () => undefined, src } : null;
    }
    void request
      .then((resolved) => {
        if (cancelled) {
          resolved?.dispose();
          return;
        }
        displaySource = resolved;
        setSource(resolved?.src ?? null);
      })
      .catch(() => {
        if (!cancelled) setSource(null);
      });

    return () => {
      cancelled = true;
      controller.abort();
      displaySource?.dispose();
    };
  }, [
    coverSnapshot,
    novel.cover,
    novel.id,
    novel.isLocal,
    novel.name,
    novel.path,
    novel.pluginId,
    options.allowSourceFallback,
    options.plugin,
  ]);

  return source;
}
