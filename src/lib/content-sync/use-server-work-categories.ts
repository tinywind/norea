import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listUserWorkCategories, type WorkCategoryLookup } from "../../db/user-state";

function workKey(pluginId: string, novelPath: string): string {
  return JSON.stringify([pluginId, novelPath]);
}

/**
 * The user's categories for content-server works, resolved on this device: a library work answers from its
 * local categories and any other work from the shared state received from that server.
 */
export function useServerWorkCategories(
  server: string,
  works: readonly WorkCategoryLookup[],
  enabled = true,
): (pluginId: string, novelPath: string) => readonly string[] {
  const lookups = works.map(({ pluginId, novelId, novelPath }) => ({ pluginId, novelId, novelPath }));
  const categories = useQuery({
    queryKey: ["category", "server-works", server, lookups],
    queryFn: () => listUserWorkCategories(server, lookups),
    enabled: enabled && !!server && lookups.length > 0,
    networkMode: "always",
    // Keep the shown categories while another page of works is added to the lookup.
    placeholderData: previous => previous,
    staleTime: 30_000,
  });
  const byWork = useMemo(
    () => new Map((categories.data ?? []).map(work => [workKey(work.pluginId, work.novelPath), work.categories])),
    [categories.data],
  );
  return useCallback((pluginId: string, novelPath: string) => byWork.get(workKey(pluginId, novelPath)) ?? [], [byWork]);
}
