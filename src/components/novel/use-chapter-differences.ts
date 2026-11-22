import { isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { ChapterListRow } from "../../db/queries/chapter";
import { isAbortError } from "../../lib/abort";
import { scanChapterDifferences } from "../../lib/content-sync/chapter-differences";
import type { ServerNovelSource } from "../../lib/content-sync/novel-source";

export function useChapterDifferences(
  novel: { id: number; pluginId: string; path: string } | undefined,
  chapters: readonly ChapterListRow[] | undefined, source: ServerNovelSource | null,
) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState({ checked: 0, total: 0 });
  const serverUrl = source?.serverUrl;
  const workId = source?.workId;
  const novelId = novel?.id;
  const query = useQuery({
    queryKey: ["content-server", "chapter-differences", serverUrl, workId, novelId,
      chapters?.map(chapter => `${chapter.id}:${chapter.updatedAt}:${chapter.contentBytes}:${chapter.mediaBytes}`).join(",")],
    queryFn: ({ signal }) => {
      if (!novel || !source) throw new Error("Chapter comparison requires a server work.");
      setProgress({ checked: 0, total: 0 });
      return scanChapterDifferences(novel, source, signal, (checked, total) => {
        if (checked === 0 || checked % 10 === 0 || checked === total) setProgress({ checked, total });
      });
    },
    enabled: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    meta: { errorPresentation: "inline" },
  });
  const cancel = useCallback(() => {
    void queryClient.cancelQueries({
      queryKey: ["content-server", "chapter-differences", serverUrl, workId, novelId],
    });
  }, [queryClient, serverUrl, workId, novelId]);
  const error = query.error && !isAbortError(query.error) && !isCancelledError(query.error)
    ? query.error
    : null;
  return { ...query, error, progress, cancel };
}
