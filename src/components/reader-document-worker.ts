import { prepareReaderDocument } from "./reader-document";
import type { PreparedReaderDocument } from "./reader-document";

export interface ReaderDocumentWorkerRequest {
  id: number;
  html: string;
  bionicReading: boolean;
}

export type ReaderDocumentWorkerResponse =
  | { id: number; result: PreparedReaderDocument }
  | { id: number; error: string };

interface ReaderDocumentWorkerScope {
  onmessage:
    | ((event: MessageEvent<ReaderDocumentWorkerRequest>) => void)
    | null;
  postMessage(message: ReaderDocumentWorkerResponse): void;
}

const workerScope = globalThis as unknown as ReaderDocumentWorkerScope;

workerScope.onmessage = ({ data }) => {
  try {
    workerScope.postMessage({
      id: data.id,
      result: prepareReaderDocument(data.html, data.bionicReading),
    });
  } catch (error) {
    workerScope.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
