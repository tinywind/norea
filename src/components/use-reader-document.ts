import { useEffect, useRef, useState } from "react";
import type { PreparedReaderDocument } from "./reader-document";
import {
  getPreparedReaderDocument,
  prepareReaderDocumentAsync,
} from "./reader-document-preparation";

interface ReaderDocumentState {
  html: string;
  bionicReading: boolean;
  document?: PreparedReaderDocument;
  error?: Error;
}

export function useReaderDocument(
  html: string | null,
  bionicReading: boolean,
  contentKey: number | string,
) {
  const [state, setState] = useState<ReaderDocumentState | null>(null);
  const displayed = useRef<{
    contentKey: number | string;
    document: PreparedReaderDocument;
  } | null>(null);
  const current =
    state?.html === html && state.bionicReading === bionicReading
      ? state
      : null;
  const prepared = html
    ? (getPreparedReaderDocument(html, bionicReading) ?? current?.document)
    : undefined;
  const document =
    prepared ??
    (html && displayed.current?.contentKey === contentKey
      ? displayed.current.document
      : undefined);

  useEffect(() => {
    if (html && prepared) displayed.current = { contentKey, document: prepared };
    else if (displayed.current?.contentKey !== contentKey) displayed.current = null;
  }, [contentKey, html, prepared]);

  useEffect(() => {
    if (!html || getPreparedReaderDocument(html, bionicReading)) return;
    const controller = new AbortController();
    void prepareReaderDocumentAsync(html, bionicReading, controller.signal).then(
      (document) => {
        if (!controller.signal.aborted) {
          setState({ html, bionicReading, document });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            html,
            bionicReading,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );
    return () => controller.abort();
  }, [html, bionicReading]);

  return {
    document,
    error: current?.error,
    isPending: Boolean(html && !document && !current?.error),
  };
}
