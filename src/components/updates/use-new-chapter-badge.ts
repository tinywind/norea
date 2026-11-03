import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { countNewLibraryChaptersSince } from "../../db/queries/chapter";
import { subscribeUpdatesIndexChanges } from "../../lib/updates/update-index-events";
import { useUpdatesSeenStore } from "../../store/updates-seen";

const NEW_CHAPTER_COUNT_KEY = ["updates", "new-chapter-count"] as const;

/** Unread chapters found by checks since the user last opened Updates. */
export function useNewChapterBadgeCount(): number {
  const queryClient = useQueryClient();
  const seenAt = useUpdatesSeenStore((state) => state.updatesSeenAt);
  const count = useQuery({
    queryKey: [...NEW_CHAPTER_COUNT_KEY, seenAt],
    queryFn: () => countNewLibraryChaptersSince(seenAt),
  });
  useEffect(() => subscribeUpdatesIndexChanges(() => {
    void queryClient.invalidateQueries({ queryKey: NEW_CHAPTER_COUNT_KEY });
  }), [queryClient]);
  return count.data ?? 0;
}
