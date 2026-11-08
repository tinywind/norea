import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { syncServerNovelOnOpen } from "../../lib/content-sync/work-refresh";
import { readServerNovelSource } from "../../lib/content-sync/novel-source";
import { checkNovelIfStale } from "../../lib/updates/freshness-scheduler";
import { useContentSyncStore } from "../../store/content-sync";
import { chaptersKey, novelKey } from "./novel-detail-model";

/**
 * On open, refreshes content-server metadata. Only works without a server binding receive
 * automatic source checks. A started source check outlives the page so its outcome is saved.
 */
export function useServerNovelSync(id: number, active: boolean, name: string) {
  const queryClient = useQueryClient();
  const serverUrl = useContentSyncStore(state => state.serverUrl);
  const { t } = useTranslation();
  const title = useRef("");
  title.current = t("tasks.task.checkUpdates", { name });
  const [serverError, setServerError] = useState<unknown>(null);
  const [sourceError, setSourceError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
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
        if (await readServerNovelSource(id) || controller.signal.aborted) return;
        sourceRefreshed = await checkNovelIfStale(id, title.current, new AbortController().signal, {
          onStart: () => { if (!controller.signal.aborted) setChecking(true); },
        });
        if (sourceRefreshed) await invalidate();
      }
      catch (error) { if (!controller.signal.aborted) setSourceError(error); }
      finally { if (!controller.signal.aborted) setChecking(false); }
    })();
    return () => { controller.abort(); setChecking(false); };
  }, [id, active, serverUrl, queryClient, attempt]);
  const retry = useCallback(() => setAttempt(current => current + 1), []);
  return { checking, serverError, sourceError, retry };
}
