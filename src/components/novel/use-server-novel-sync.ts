import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { refreshServerNovelFromSource, syncServerNovelOnOpen } from "../../lib/content-sync/work-refresh";
import { useContentSyncStore } from "../../store/content-sync";
import { chaptersKey, novelKey } from "./novel-detail-model";

export function useServerNovelSync(id: number, active: boolean, name: string) {
  const queryClient = useQueryClient();
  const serverUrl = useContentSyncStore(state => state.serverUrl);
  const { t } = useTranslation();
  const title = useRef("");
  title.current = t("tasks.task.refreshNovelMetadata", { name });
  const [serverError, setServerError] = useState<unknown>(null);
  const [sourceError, setSourceError] = useState<unknown>(null);
  useEffect(() => {
    if (!active || id <= 0) return;
    const controller = new AbortController();
    const invalidate = async () => {
      if (controller.signal.aborted) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: novelKey(id), exact: true }),
        queryClient.invalidateQueries({ queryKey: chaptersKey(id), exact: true }),
        queryClient.invalidateQueries({ queryKey: ["content-server", "novel-chapters"] }),
      ]);
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"], refetchType: "none" });
    };
    setServerError(null);
    setSourceError(null);
    let sourceRefreshed = false;
    void (async () => {
      try { if (await syncServerNovelOnOpen(id, controller.signal, () => !sourceRefreshed)) await invalidate(); }
      catch (error) { if (!controller.signal.aborted) setServerError(error); }
    })();
    void (async () => {
      try {
        sourceRefreshed = await refreshServerNovelFromSource(id, title.current, controller.signal);
        if (sourceRefreshed) await invalidate();
      }
      catch (error) { if (!controller.signal.aborted) setSourceError(error); }
    })();
    return () => controller.abort();
  }, [id, active, serverUrl, queryClient]);
  return { serverError, sourceError };
}
