import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listUserWorkCategories, type WorkCategoryLookup } from "../db/user-state";
import { useContentSyncStore } from "../store/content-sync";

export interface UserWorkCategoryTarget {
  pluginId: string;
  novelId?: string;
  novelPath: string;
}

function workCategoryKey(pluginId: string, novelPath: string): string {
  return JSON.stringify([pluginId, novelPath]);
}

export function normalizeWorkCategoryLookups(
  works: readonly UserWorkCategoryTarget[],
): WorkCategoryLookup[] {
  const deduped = new Map<string, WorkCategoryLookup>();
  for (const work of works) {
    if (!work.pluginId || !work.novelPath) continue;
    const key = workCategoryKey(work.pluginId, work.novelPath);
    const novelId = work.novelId ?? "";
    const existing = deduped.get(key);
    if (!existing || (existing.novelId === "" && novelId !== "")) {
      deduped.set(key, {
        pluginId: work.pluginId,
        novelId,
        novelPath: work.novelPath,
      });
    }
  }
  return [...deduped.values()];
}

/**
 * Resolves the user's categories for source works from local categories first and, when a content
 * server is configured, falls back to categories synced in that server's personal state.
 */
export function useUserWorkCategories(
  works: readonly UserWorkCategoryTarget[],
  enabled = true,
): (pluginId: string, novelPath: string) => readonly string[] {
  const serverUrl = useContentSyncStore((state) => state.serverUrl);
  const normalized = normalizeWorkCategoryLookups(works);
  const signature = JSON.stringify(normalized);
  const lookups = useMemo<WorkCategoryLookup[]>(
    () => (signature === "[]" ? [] : (JSON.parse(signature) as WorkCategoryLookup[])),
    [signature],
  );

  const categories = useQuery({
    queryKey: ["category", "user-works", serverUrl, lookups],
    queryFn: () => listUserWorkCategories(serverUrl, lookups),
    enabled: enabled && lookups.length > 0,
    networkMode: "always",
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });

  const byWork = useMemo(
    () =>
      new Map(
        (categories.data ?? []).map((work) => [
          workCategoryKey(work.pluginId, work.novelPath),
          work.categories,
        ]),
      ),
    [categories.data],
  );

  return useCallback(
    (pluginId: string, novelPath: string) =>
      byWork.get(workCategoryKey(pluginId, novelPath)) ?? [],
    [byWork],
  );
}
