import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getNovelCoverSnapshot,
  acquireCachedNovelCoverSource,
  clearNovelCoverDisplayCache,
  peekCachedNovelCoverSrc,
  persistCachedNovelCoverSource,
  subscribeNovelCoverChanges,
  type NovelCoverStorageInput,
} from "./novel-cover-storage";
import { pluginManager } from "./plugins/manager";
import { subscribeWorkMetadataChanges } from "./work-metadata";
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
  const [metadataRevision, setMetadataRevision] = useState(0);
  const pendingRef = useRef(false);
  const subscribeToCover = useCallback(
    (onStoreChange: () => void) =>
      subscribeNovelCoverChanges(
        (changedNovelId) => {
          if (changedNovelId === 0 || novel.id === 0 || changedNovelId === novel.id) {
            onStoreChange();
          }
        },
        {
          novelId: novel.id,
          path: novel.path,
          pluginId: novel.pluginId,
        },
      ),
    [novel.id, novel.path, novel.pluginId],
  );
  const getCoverSnapshot = useCallback(
    () =>
      getNovelCoverSnapshot(novel.id, {
        path: novel.path,
        pluginId: novel.pluginId,
      }),
    [novel.id, novel.path, novel.pluginId],
  );
  const coverSnapshot = useSyncExternalStore(
    subscribeToCover,
    getCoverSnapshot,
    getCoverSnapshot,
  );

  useEffect(() => subscribeWorkMetadataChanges((identity) => {
    const exact = identity?.pluginId === novel.pluginId && identity.novelPath === novel.path;
    if (identity && !exact) return;
    // A global recovery event is frequent while the library storage index rebuilds.
    // Retry settled placeholders only; already displayed or in-flight covers stay
    // stable. An exact work event always invalidates because that work's cover
    // bytes/directory may change.
    if (!exact && (source !== null || pendingRef.current)) return;
    clearNovelCoverDisplayCache(novel.id, { pluginId: novel.pluginId, path: novel.path });
    setMetadataRevision(revision => revision + 1);
  }), [novel.id, novel.path, novel.pluginId, source]);

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

    if (localCover || novel.pluginId.trim() === "") {
      pendingRef.current = false;
      return;
    }

    pendingRef.current = cachedSource === undefined;
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
        pendingRef.current = false;
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
        if (!cancelled) {
          pendingRef.current = false;
          setSource(null);
        }
      });

    return () => {
      cancelled = true;
      pendingRef.current = false;
      release?.();
    };
  }, [
    coverSnapshot,
    novel.cover,
    novel.coverOverride,
    novel.id,
    novel.isLocal,
    novel.inLibrary,
    novel.name,
    metadataRevision,
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
