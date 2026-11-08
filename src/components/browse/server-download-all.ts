import { notifications } from "@mantine/notifications";
import type { QueryClient } from "@tanstack/react-query";
import { findNovelBySource } from "../../db/queries/novel";
import type { TranslationKey } from "../../i18n";
import { isAbortError } from "../../lib/abort";
import { openServerNovel, type ServerWorkSummary } from "../../lib/content-sync/browse";
import { useContentSyncStore } from "../../store/content-sync";
import { showErrorToast } from "../../lib/runtime/error-toast";
import { downloadOnceNotice, queueChapterDownloadsOnce } from "../library/download-once";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * Waits for `libraryAdd`, the add of the works not in the library yet, to
 * settle, then queues every chapter not downloaded yet of each work now in the
 * library, through the library's download-once path. Works the add failed or
 * did not reach are skipped and counted in the toast. A cancelled add queues
 * nothing.
 */
export async function downloadServerWorksOnce(
  works: readonly ServerWorkSummary[],
  libraryAdd: Promise<unknown> | null,
  t: Translate,
  queryClient: QueryClient,
  server = useContentSyncStore.getState().serverUrl,
): Promise<void> {
  try {
    if (libraryAdd) {
      try {
        await libraryAdd;
      } catch (error) {
        if (isAbortError(error)) return;
      }
    }
    const novelIds: number[] = [];
    let notAdded = 0;
    for (const work of new Map(works.map(work => [work.id, work])).values()) {
      const novel = await findNovelBySource(work.identity.pluginId, work.identity.novelPath);
      if (novel?.inLibrary) {
        await openServerNovel(server, work);
        novelIds.push(novel.id);
      }
      else notAdded += 1;
    }
    const notice = downloadOnceNotice(t, await queueChapterDownloadsOnce(novelIds, t, queryClient, { kind: "all" }, { serverOnly: true }));
    notifications.show(notAdded > 0
      ? { color: "warn", message: notice.message, title: t("serverLibraryAdd.downloadAllNotAdded", { count: notAdded }) }
      : notice);
  } catch (error) {
    showErrorToast(t("serverLibraryAdd.downloadAll"), error);
  }
}
