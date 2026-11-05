import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { listAllServerWorks, type ServerWorkSummary } from "../../lib/content-sync/browse";
import { showErrorToast } from "../../lib/runtime/error-toast";

interface ServerWorkSelectionOptions {
  active: boolean;
  query: string;
  server: string;
  source: string;
  token: string | undefined;
}

export interface ServerWorkSelectAllProgress {
  loaded: number;
  total: number;
}

/**
 * Server-grid selection, including works already in the library.
 * Select all gathers every work matching the current search and source,
 * including pages the grid has not loaded; changing the filters or server
 * clears the selection and discards a gather in flight.
 */
export function useServerWorkSelection({ active, query, server, source, token }: ServerWorkSelectionOptions) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ReadonlyMap<string, ServerWorkSummary>>(() => new Map());
  const [selecting, setSelecting] = useState(false);
  const [gathering, setGathering] = useState<ServerWorkSelectAllProgress | null>(null);
  /** How many matching works the last select all found. */
  const [selectAllCount, setSelectAllCount] = useState<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const selectionMode = selecting || selected.size > 0;

  const cancelGather = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setGathering(null);
  }, []);

  const exit = useCallback(() => {
    cancelGather();
    setSelected(new Map());
    setSelectAllCount(null);
    setSelecting(false);
  }, [cancelGather]);

  useEffect(() => {
    cancelGather();
    setSelected(new Map());
    setSelectAllCount(null);
  }, [cancelGather, query, server, source]);

  useEffect(() => () => requestRef.current?.abort(), []);

  useOverlayBackNavigation(active && selectionMode, exit);

  const enter = useCallback((work?: ServerWorkSummary) => {
    setSelecting(true);
    if (work) setSelected(current => new Map(current).set(work.id, work));
  }, []);

  const toggle = useCallback((work: ServerWorkSummary) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(work.id)) next.delete(work.id);
      else next.set(work.id, work);
      return next;
    });
  }, []);

  const deselectAll = useCallback(() => {
    cancelGather();
    setSelected(new Map());
  }, [cancelGather]);

  const selectAll = useCallback(() => {
    if (!token || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setGathering({ loaded: 0, total: 0 });
    void listAllServerWorks(server, token, query, source, (loaded, total) => {
      if (!controller.signal.aborted) setGathering({ loaded, total });
    }, controller.signal)
      .then((works) => {
        if (controller.signal.aborted) return;
        const all = new Map(works.map(work => [work.id, work]));
        setSelected(all);
        setSelectAllCount(all.size);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) showErrorToast(t("selection.selectAll"), error);
      })
      .finally(() => {
        if (requestRef.current !== controller) return;
        requestRef.current = null;
        setGathering(null);
      });
  }, [query, server, source, t, token]);

  return {
    allSelected: selectAllCount !== null && selected.size > 0 && selected.size >= selectAllCount,
    deselectAll,
    enter,
    exit,
    gathering,
    selected,
    selectAll,
    selectionMode,
    toggle,
  };
}
