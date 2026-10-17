import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getNovelCoverSnapshot,
  acquireCachedNovelCoverSource,
  peekCachedNovelCoverSrc,
  persistCachedNovelCoverSource,
  subscribeNovelCoverChanges,
  type NovelCoverStorageInput,
} from "./novel-cover-storage";
import { pluginManager } from "./plugins/manager";
import type { Plugin } from "./plugins/types";

export interface NovelCoverSourceInput extends NovelCoverStorageInput {
  cover: string | null;
  isLocal?: boolean | null;
  inLibrary?: boolean | null;
}

interface NovelCoverSourceOptions {
  allowSourceFallback?: boolean;
  plugin?: Plugin | null;
}

export function useNovelCoverSource(
  novel: NovelCoverSourceInput,
  options: NovelCoverSourceOptions = {},
): string | null {
  const [source, setSource] = useState<string | null>(() =>
    initialNovelCoverSource(novel, options),
  );
  const subscribeToCover = useCallback(
    (onStoreChange: () => void) =>
      subscribeNovelCoverChanges((changedNovelId) => {
        if (changedNovelId === 0 || novel.id === 0 || changedNovelId === novel.id) {
          onStoreChange();
        }
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
    let release: (() => void) | undefined;
    let persist: (() => Promise<void>) | undefined;
    const localCover = novel.isLocal ? novel.cover?.trim() || null : null;
    const loadedPlugin =
      options.plugin ?? pluginManager.getPlugin(novel.pluginId);
    const cachedSource =
      !localCover
        ? peekCachedNovelCoverSrc(novel, {
            allowSourceFallback: options.allowSourceFallback,
            plugin: loadedPlugin,
          })
        : undefined;
    setSource(cachedSource === undefined ? localCover : cachedSource);

    if (localCover || novel.pluginId.trim() === "") return;

    const request = resolveCover();

    async function resolveCover(): Promise<string | null> {
      let plugin = loadedPlugin;
      if (!plugin && !novel.isLocal) {
        await pluginManager.loadInstalledFromDb().catch(() => undefined);
        plugin = pluginManager.getPlugin(novel.pluginId);
      }
      if (cancelled) return null;
      const cacheOptions = { allowSourceFallback: options.allowSourceFallback, plugin };
      const cached = peekCachedNovelCoverSrc(novel, cacheOptions);
      if (cached !== undefined) setSource(cached);
      const handle = acquireCachedNovelCoverSource(novel, cacheOptions);
      release = handle.release;
      if (novel.inLibrary && !novel.isLocal) {
        persist = () => persistCachedNovelCoverSource(novel, cacheOptions);
      }
      return handle.promise;
    }
    void request
      .then((resolved) => {
        if (cancelled) return;
        setSource(resolved);
        if (resolved) {
          void persist?.().catch((error: unknown) => {
            console.debug("[novel-cover] recovered cover could not be stored", {
              error,
              novelId: novel.id,
              pluginId: novel.pluginId,
            });
          });
        }
      })
      .catch(() => {
        if (!cancelled) setSource(null);
      });

    return () => {
      cancelled = true;
      release?.();
    };
  }, [
    coverSnapshot,
    novel.cover,
    novel.id,
    novel.isLocal,
    novel.inLibrary,
    novel.name,
    novel.path,
    novel.pluginId,
    options.allowSourceFallback,
    options.plugin,
  ]);

  return source;
}

function initialNovelCoverSource(
  novel: NovelCoverSourceInput,
  options: NovelCoverSourceOptions,
): string | null {
  if (novel.isLocal && novel.cover?.trim()) return novel.cover.trim();
  if (novel.pluginId.trim() === "") return null;

  return (
    peekCachedNovelCoverSrc(novel, {
      allowSourceFallback: options.allowSourceFallback,
      plugin: options.plugin ?? pluginManager.getPlugin(novel.pluginId),
    }) ?? null
  );
}
