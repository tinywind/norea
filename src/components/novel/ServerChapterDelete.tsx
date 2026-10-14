import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { deleteServerChapters } from "../../lib/content-sync/sync";
import { describeError } from "../../lib/errors";
import { useContentSyncStore } from "../../store/content-sync";

export function ServerChapterDelete({ novel, chapters }: {
  novel: Pick<NovelDetailRecord, "pluginId" | "path">;
  chapters: readonly Pick<ChapterListRow, "path" | "chapterNumber">[];
}) {
  const { t } = useTranslation();
  const serverUrl = useContentSyncStore(state => state.serverUrl);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteServerChapters(chapters.map(chapter => ({
      pluginId: novel.pluginId, novelPath: novel.path,
      chapterPath: chapter.path, chapterNumber: chapter.chapterNumber,
    }))),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-server", "novel-chapters"] });
      void queryClient.invalidateQueries({ queryKey: ["content-server", serverUrl, "browse"] });
      notifications.show({ message: t("contentSync.serverDeleteDone") });
    },
    onError: error => notifications.show({ color: "red", title: t("contentSync.deleteServer"), message: describeError(error) }),
  });
  if (!serverUrl) return null;
  return <Button color="red" variant="subtle" size="compact-sm" loading={remove.isPending}
    disabled={!chapters.length} onClick={() => {
      if (window.confirm(t("contentSync.deleteSelectedConfirm", { count: chapters.length }))) remove.mutate();
    }}>{t("contentSync.deleteServer")}</Button>;
}
