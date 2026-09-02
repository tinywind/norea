import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getNovelCoverSnapshot,
  peekCachedNovelCoverSrc,
  resolveCachedNovelCoverSrc,
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
  const [source, setSource] = useState<string | null>(() =>
    initialNovelCoverSource(novel, options),
  );
  const subscribeToCover = useCallback(
    (onStoreChange: () => void) =>
      subscribeNovelCoverChanges((changedNovelId) => {
        if (changedNovelId === 0 || changedNovelId === novel.id) {
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
    let displaySource: NovelCoverDisplaySource | null = null;
    const controller = new AbortController();
    const localCover = novel.isLocal ? novel.cover?.trim() || null : null;
    const loadedPlugin =
      options.plugin ?? pluginManager.getPlugin(novel.pluginId);
    const cachedSource =
      novel.id > 0 && !novel.isLocal
        ? peekCachedNovelCoverSrc(novel, {
            allowSourceFallback: options.allowSourceFallback,
            plugin: loadedPlugin,
          })
        : undefined;
    setSource(cachedSource === undefined ? localCover : cachedSource);

    if (novel.isLocal || novel.pluginId.trim() === "") return;

    const request = resolveCover();

    async function resolveCover(): Promise<NovelCoverDisplaySource | null> {
      let plugin = loadedPlugin;
      if (!plugin) {
        await pluginManager.loadInstalledFromDb().catch(() => undefined);
        plugin = pluginManager.getPlugin(novel.pluginId);
      }
      if (controller.signal.aborted) return null;

      if (novel.id > 0) {
        const cacheOptions = {
          allowSourceFallback: options.allowSourceFallback,
          plugin,
        };
        const cached = peekCachedNovelCoverSrc(novel, cacheOptions);
        if (cached !== undefined && !cancelled) setSource(cached);
        const src = await resolveCachedNovelCoverSrc(novel, cacheOptions);
        return src ? { dispose: () => undefined, src } : null;
      }

      if (options.allowSourceFallback && plugin) {
        return resolveNovelCoverDisplaySource(
          plugin,
          novel,
          controller.signal,
        );
      }
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

function initialNovelCoverSource(
  novel: NovelCoverSourceInput,
  options: NovelCoverSourceOptions,
): string | null {
  if (novel.isLocal) return novel.cover?.trim() || null;
  if (novel.id <= 0 || novel.pluginId.trim() === "") return null;

  return (
    peekCachedNovelCoverSrc(novel, {
      allowSourceFallback: options.allowSourceFallback,
      plugin: options.plugin ?? pluginManager.getPlugin(novel.pluginId),
    }) ?? null
  );
}
