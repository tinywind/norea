import { prepareReaderDocument } from "./reader-document";
import type { PreparedReaderDocument } from "./reader-document";
import type {
  ReaderDocumentWorkerRequest,
  ReaderDocumentWorkerResponse,
} from "./reader-document-worker";

interface ReaderDocumentSubscriber {
  resolve(document: PreparedReaderDocument): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort(): void;
}

interface PendingReaderDocument extends ReaderDocumentWorkerRequest {
  subscribers: Set<ReaderDocumentSubscriber>;
  worker?: Worker;
  timeout?: ReturnType<typeof setTimeout>;
  cancellationTimeout?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface CachedReaderDocument {
  html: string;
  bionicReading: boolean;
  document: PreparedReaderDocument;
}

const completedDocuments: CachedReaderDocument[] = [];
const pendingDocuments = new Set<PendingReaderDocument>();
let nextRequestId = 0;

export function getPreparedReaderDocument(
  html: string,
  bionicReading: boolean,
): PreparedReaderDocument | undefined {
  const index = completedDocuments.findIndex(
    (entry) => entry.html === html && entry.bionicReading === bionicReading,
  );
  if (index === -1) return undefined;
  const entry = completedDocuments.splice(index, 1)[0]!;
  completedDocuments.unshift(entry);
  return entry.document;
}

function stopWorker(request: PendingReaderDocument): void {
  clearTimeout(request.timeout);
  request.timeout = undefined;
  if (request.worker) {
    request.worker.onmessage = null;
    request.worker.onerror = null;
    request.worker.onmessageerror = null;
    request.worker.terminate();
    request.worker = undefined;
  }
}

function discardRequest(request: PendingReaderDocument): void {
  request.settled = true;
  stopWorker(request);
  clearTimeout(request.cancellationTimeout);
  pendingDocuments.delete(request);
}

function finishRequest(
  request: PendingReaderDocument,
  outcome: { result: PreparedReaderDocument } | { error: unknown },
): void {
  if (request.settled) return;
  discardRequest(request);
  if ("result" in outcome && request.subscribers.size > 0) {
    completedDocuments.unshift({
      html: request.html,
      bionicReading: request.bionicReading,
      document: outcome.result,
    });
    if (completedDocuments.length > 4) completedDocuments.pop();
  }
  for (const subscriber of request.subscribers) {
    subscriber.signal?.removeEventListener("abort", subscriber.onAbort);
    if ("result" in outcome) subscriber.resolve(outcome.result);
    else subscriber.reject(outcome.error);
  }
  request.subscribers.clear();
}

function prepareSynchronously(request: PendingReaderDocument): void {
  if (request.settled) return;
  if (request.subscribers.size === 0) {
    discardRequest(request);
    return;
  }
  stopWorker(request);
  try {
    finishRequest(request, {
      result: prepareReaderDocument(request.html, request.bionicReading),
    });
  } catch (error) {
    finishRequest(request, { error });
  }
}

function startPreparation(request: PendingReaderDocument): void {
  try {
    const worker = new Worker(
      new URL("./reader-document-worker.ts", import.meta.url),
      { type: "module" },
    );
    request.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<ReaderDocumentWorkerResponse>) => {
      if (data.id !== request.id || request.settled) return;
      if ("error" in data) prepareSynchronously(request);
      else finishRequest(request, data);
    };
    worker.onerror = () => prepareSynchronously(request);
    worker.onmessageerror = () => prepareSynchronously(request);
    request.timeout = setTimeout(() => prepareSynchronously(request), 30_000);
    worker.postMessage({
      id: request.id,
      html: request.html,
      bionicReading: request.bionicReading,
    } satisfies ReaderDocumentWorkerRequest);
  } catch {
    prepareSynchronously(request);
  }
}

export function prepareReaderDocumentAsync(
  html: string,
  bionicReading: boolean,
  signal?: AbortSignal,
): Promise<PreparedReaderDocument> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ??
        new DOMException("Document preparation cancelled.", "AbortError"),
    );
  }
  const cached = getPreparedReaderDocument(html, bionicReading);
  if (cached) return Promise.resolve(cached);

  const existing = [...pendingDocuments].find(
    (request) => request.html === html && request.bionicReading === bionicReading,
  );
  const request: PendingReaderDocument = existing ?? {
    id: ++nextRequestId,
    html,
    bionicReading,
    subscribers: new Set(),
    settled: false,
  };
  pendingDocuments.add(request);
  clearTimeout(request.cancellationTimeout);
  request.cancellationTimeout = undefined;

  return new Promise((resolve, reject) => {
    const subscriber: ReaderDocumentSubscriber = {
      resolve,
      reject,
      signal,
      onAbort() {
        request.subscribers.delete(subscriber);
        reject(
          signal?.reason ??
            new DOMException("Document preparation cancelled.", "AbortError"),
        );
        if (request.subscribers.size === 0 && !request.settled) {
          // Effect cleanup and the next reader mount can share pending preparation.
          request.cancellationTimeout = setTimeout(
            () => discardRequest(request),
            0,
          );
        }
      },
    };
    request.subscribers.add(subscriber);
    signal?.addEventListener("abort", subscriber.onAbort, { once: true });
    if (!existing) startPreparation(request);
  });
}
