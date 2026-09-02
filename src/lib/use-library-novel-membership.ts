import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listLibraryNovelIdentities } from "../db/queries/novel";

const LIBRARY_MEMBERSHIP_QUERY_KEY = [
  "novel",
  "library",
  "membership",
] as const;

function libraryNovelIdentityKey(pluginId: string, path: string): string {
  return JSON.stringify([pluginId, path]);
}

export function useLibraryNovelMembership(): (
  pluginId: string,
  path: string,
) => boolean {
  const membership = useQuery({
    queryKey: LIBRARY_MEMBERSHIP_QUERY_KEY,
    queryFn: listLibraryNovelIdentities,
    staleTime: Infinity,
  });
  const identityKeys = useMemo(
    () =>
      new Set(
        (membership.data ?? []).map(({ pluginId, path }) =>
          libraryNovelIdentityKey(pluginId, path),
        ),
      ),
    [membership.data],
  );

  return useCallback(
    (pluginId: string, path: string) =>
      identityKeys.has(libraryNovelIdentityKey(pluginId, path)),
    [identityKeys],
  );
}
