import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ChapterListRow } from "../../db/queries/chapter";
import { scanChapterDifferences } from "../../lib/content-sync/chapter-differences";
import type { ServerNovelSource } from "../../lib/content-sync/novel-source";

export function useChapterDifferences(
  novel: { id: number; pluginId: string; path: string } | undefined,
  chapters: readonly ChapterListRow[] | undefined, source: ServerNovelSource | null, active: boolean,
) {
  const [progress, setProgress] = useState({ checked: 0, total: 0 });
  const query = useQuery({
    queryKey: ["content-server", "chapter-differences", source?.serverUrl, source?.workId, novel?.id,
      chapters?.map(chapter => `${chapter.id}:${chapter.updatedAt}:${chapter.contentBytes}:${chapter.mediaBytes}`).join(",")],
    queryFn: ({ signal }) => {
      if (!novel || !source) throw new Error("Chapter comparison requires a server work.");
      return scanChapterDifferences(novel, source, signal, (checked, total) => {
        if (checked % 10 === 0 || checked === total) setProgress({ checked, total });
      });
    },
    enabled: active && !!novel && !!source && !!chapters,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    meta: { errorPresentation: "inline" },
  });
  return { ...query, progress };
}
