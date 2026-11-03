import { describeError } from "../errors";
import { requestAbortedError } from "../abort";
import {
  cancelChapterDownloadBatches,
  enqueueChapterDownloadBatch,
  type ChapterDownloadBatchHandle,
  type ChapterDownloadBatchJob,
  type ChapterDownloadBatchResult,
} from "./chapter-download";

export interface ChapterDownloadRequestInput {
  key: string;
  title: string;
  novelIds: readonly number[];
  total?: number;
  prepare: (signal: AbortSignal) => Promise<ChapterDownloadBatchJob>;
}

export interface ChapterDownloadRequestState {
  id: string;
  title: string;
  novelIds: readonly number[];
  total: number | null;
  phase: "preparing" | "publishing" | "failed";
  error: string | null;
}

interface PendingRequest {
  key: string;
  state: ChapterDownloadRequestState;
  handle: ChapterDownloadBatchHandle;
  child?: ChapterDownloadBatchHandle;
  controller: AbortController;
  cancel: (reason: DOMException) => void;
  visible: boolean;
}

const requests = new Map<string, PendingRequest>();
const requestsByKey = new Map<string, PendingRequest>();
const listeners = new Set<() => void>();
let snapshot: readonly ChapterDownloadRequestState[] = [];

function publish(): void {
  snapshot = [...requests.values()].filter(request => request.visible)
    .map(request => ({ ...request.state, novelIds: [...request.state.novelIds] }));
  for (const listener of listeners) listener();
}

export function getChapterDownloadRequestSnapshot(): readonly ChapterDownloadRequestState[] {
  return snapshot;
}

export function subscribeChapterDownloadRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function submitChapterDownloadRequest(input: ChapterDownloadRequestInput): ChapterDownloadBatchHandle {
  const existing = requestsByKey.get(input.key);
  if (existing && existing.state.phase !== "failed") return existing.handle;
  if (existing) requests.delete(existing.state.id);
  const id = `download-request-${crypto.randomUUID()}`;
  const controller = new AbortController();
  let cancel!: PendingRequest["cancel"];
  const cancellation = new Promise<never>((_, reject) => { cancel = reject; });
  let materialize!: () => void;
  let rejectMaterialize!: (error: unknown) => void;
  const materialized = new Promise<void>((resolve, reject) => { materialize = resolve; rejectMaterialize = reject; });
  let complete!: (result: ChapterDownloadBatchResult) => void;
  let rejectComplete!: (error: unknown) => void;
  const promise = new Promise<ChapterDownloadBatchResult>((resolve, reject) => { complete = resolve; rejectComplete = reject; });
  const handle = { id, materialized, promise };
  const request: PendingRequest = {
    key: input.key, handle, controller, cancel, visible: true,
    state: { id, title: input.title, novelIds: [...input.novelIds], total: input.total ?? null, phase: "preparing", error: null },
  };
  requests.set(id, request);
  requestsByKey.set(input.key, request);
  publish();
  void (async () => {
    let published = false;
    try {
      const batch = await Promise.race([input.prepare(controller.signal), cancellation]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (batch.total === 0 || (Array.isArray(batch.jobs) && batch.jobs.length === 0)) {
        request.visible = false;
        publish();
        materialize();
        complete({ total: 0, succeeded: 0, failed: 0, cancelled: 0 });
        return;
      }
      request.state = { ...request.state, phase: "publishing", total: batch.total ?? (Array.isArray(batch.jobs) ? batch.jobs.length : request.state.total) };
      publish();
      const child = enqueueChapterDownloadBatch(batch);
      request.child = child;
      void child.promise.catch(() => undefined);
      if (controller.signal.aborted) {
        cancelChapterDownloadBatches([child.id]);
        throw controller.signal.reason;
      }
      await Promise.race([child.materialized, cancellation]);
      if (controller.signal.aborted) throw controller.signal.reason;
      published = true;
      request.visible = false;
      publish();
      materialize();
      complete(await Promise.race([child.promise, cancellation]));
    } catch (error) {
      if (!controller.signal.aborted && !published) {
        request.state = { ...request.state, phase: "failed", error: describeError(error) };
        publish();
      }
      rejectMaterialize(error);
      rejectComplete(error);
    } finally {
      if (request.state.phase !== "failed" && requestsByKey.get(input.key) === request) requestsByKey.delete(input.key);
      if (!request.visible) requests.delete(id);
    }
  })();
  void materialized.catch(() => undefined);
  void promise.catch(() => undefined);
  return handle;
}

export function cancelChapterDownloadRequest(id: string): void {
  const request = requests.get(id);
  if (!request || request.controller.signal.aborted) return;
  const reason = requestAbortedError();
  request.controller.abort(reason);
  request.cancel(reason);
  if (request.child) cancelChapterDownloadBatches([request.child.id]);
  request.visible = false;
  requests.delete(id);
  if (requestsByKey.get(request.key) === request) requestsByKey.delete(request.key);
  publish();
}
