import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { listAllServerWorks, type ServerWorkSummary } from "../../lib/content-sync/browse";
import { showErrorToast } from "../../lib/runtime/error-toast";

interface ServerWorkSelectionOptions {
  active: boolean;
  isInLibrary: (pluginId: string, novelPath: string) => boolean;
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
 * Server-grid selection. Works already in the library cannot be selected.
 * Select all gathers every work matching the current search and source,
 * including pages the grid has not loaded; changing the filters or server
 * clears the selection and discards a gather in flight.
 */
export function useServerWorkSelection({ active, isInLibrary, query, server, source, token }: ServerWorkSelectionOptions) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ReadonlyMap<string, ServerWorkSummary>>(() => new Map());
  const [selecting, setSelecting] = useState(false);
  const [gathering, setGathering] = useState<ServerWorkSelectAllProgress | null>(null);
  /** From the last select all: how many matching works could be selected and how many were in the library. */
  const [selectAllCounts, setSelectAllCounts] = useState<{ selectable: number; inLibrary: number } | null>(null);
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
    setSelectAllCounts(null);
    setSelecting(false);
  }, [cancelGather]);

  useEffect(() => {
    cancelGather();
    setSelected(new Map());
    setSelectAllCounts(null);
  }, [cancelGather, query, server, source]);

  useEffect(() => () => requestRef.current?.abort(), []);

  useOverlayBackNavigation(active && selectionMode, exit);

  const isSelectable = useCallback(
    (work: ServerWorkSummary) => !isInLibrary(work.identity.pluginId, work.identity.novelPath),
    [isInLibrary],
  );

  const enter = useCallback((work?: ServerWorkSummary) => {
    setSelecting(true);
    if (work && isSelectable(work)) setSelected(current => new Map(current).set(work.id, work));
  }, [isSelectable]);

  const toggle = useCallback((work: ServerWorkSummary) => {
    if (!isSelectable(work)) return;
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(work.id)) next.delete(work.id);
      else next.set(work.id, work);
      return next;
    });
  }, [isSelectable]);

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
        const selectable = works.filter(isSelectable);
        setSelected(new Map(selectable.map(work => [work.id, work])));
        setSelectAllCounts({ inLibrary: works.length - selectable.length, selectable: selectable.length });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) showErrorToast(t("selection.selectAll"), error);
      })
      .finally(() => {
        if (requestRef.current !== controller) return;
        requestRef.current = null;
        setGathering(null);
      });
  }, [isSelectable, query, server, source, t, token]);

  return {
    allSelected: selectAllCounts !== null && selected.size > 0 && selected.size >= selectAllCounts.selectable,
    deselectAll,
    enter,
    exit,
    gathering,
    /** Matching works already in the library, from the last select all. */
    inLibraryCount: selectAllCounts?.inLibrary ?? 0,
    isSelectable,
    selected,
    selectAll,
    selectionMode,
    toggle,
  };
}
