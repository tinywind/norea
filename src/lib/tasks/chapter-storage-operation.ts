export type ChapterStorageOperationScope =
  | { kind: "all" }
  | { kind: "sources"; sourceIds: readonly string[] };

type ChapterStorageOperationMode = "exclusive" | "wait";
type ChapterStorageOperationState = "active" | "pending";

interface NormalizedChapterStorageOperationScope {
  all: boolean;
  sourceIds: ReadonlySet<string>;
}

interface ChapterStorageOperationRequest {
  mode: ChapterStorageOperationMode;
  scope: NormalizedChapterStorageOperationScope;
  state: ChapterStorageOperationState;
  resolve: (release: () => void) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

const requests: ChapterStorageOperationRequest[] = [];
const exclusiveListeners = new Set<() => void>();

function notifyExclusiveListeners(): void {
  for (const listener of [...exclusiveListeners]) {
    listener();
  }
}

export interface BlockedChapterStorageSources {
  all: boolean;
  sourceIds: Set<string>;
}

export function subscribeChapterStorageOperations(
  listener: () => void,
): () => void {
  exclusiveListeners.add(listener);
  return () => {
    exclusiveListeners.delete(listener);
  };
}

export function getBlockedChapterStorageSources(): BlockedChapterStorageSources {
  let all = false;
  const sourceIds = new Set<string>();
  for (const request of requests) {
    if (request.mode !== "exclusive") continue;
    if (request.scope.all) {
      all = true;
    } else {
      for (const sourceId of request.scope.sourceIds) {
        sourceIds.add(sourceId);
      }
    }
  }
  return { all, sourceIds };
}

export function isChapterStorageBlockedForSource(sourceId: string): boolean {
  const normalized = sourceId.trim();
  if (!normalized) return false;
  for (const request of requests) {
    if (request.mode !== "exclusive") continue;
    if (request.scope.all || request.scope.sourceIds.has(normalized)) {
      return true;
    }
  }
  return false;
}

export function waitForAllChapterStorageOperations(
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (!getBlockedChapterStorageSources().all) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal!));
    };
    const check = () => {
      if (settled) return;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (!getBlockedChapterStorageSources().all) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const unsubscribe = subscribeChapterStorageOperations(check);
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("Storage operation was cancelled.", "AbortError")
  );
}

function normalizeScope(
  scope: ChapterStorageOperationScope,
): NormalizedChapterStorageOperationScope {
  if (scope.kind === "all") {
    return { all: true, sourceIds: new Set() };
  }
  if (scope.sourceIds.length === 0) {
    throw new Error("A source storage operation requires at least one source id.");
  }
  const sourceIds = new Set<string>();
  for (const sourceId of scope.sourceIds) {
    const normalized = sourceId.trim();
    if (!normalized) {
      throw new Error("Source storage operation ids must not be empty.");
    }
    sourceIds.add(normalized);
  }
  return { all: false, sourceIds };
}

function scopesOverlap(
  left: NormalizedChapterStorageOperationScope,
  right: NormalizedChapterStorageOperationScope,
): boolean {
  if (left.all || right.all) return true;
  for (const sourceId of left.sourceIds) {
    if (right.sourceIds.has(sourceId)) return true;
  }
  return false;
}

function requestsConflict(
  left: ChapterStorageOperationRequest,
  right: ChapterStorageOperationRequest,
): boolean {
  return (
    (left.mode === "exclusive" || right.mode === "exclusive") &&
    scopesOverlap(left.scope, right.scope)
  );
}

function removeRequest(request: ChapterStorageOperationRequest): void {
  const index = requests.indexOf(request);
  if (index >= 0) requests.splice(index, 1);
  if (request.signal && request.abortListener) {
    request.signal.removeEventListener("abort", request.abortListener);
  }
}

function canActivateRequest(
  request: ChapterStorageOperationRequest,
  requestIndex: number,
): boolean {
  for (let index = 0; index < requests.length; index += 1) {
    const other = requests[index]!;
    if (other === request || !requestsConflict(request, other)) continue;
    if (other.state === "active" || index < requestIndex) return false;
  }
  return true;
}

function drainRequests(): void {
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    if (
      request.state !== "pending" ||
      !canActivateRequest(request, index)
    ) {
      continue;
    }
    request.state = "active";
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener("abort", request.abortListener);
      request.abortListener = undefined;
    }
    let released = false;
    request.resolve(() => {
      if (released) return;
      released = true;
      removeRequest(request);
      drainRequests();
      if (request.mode === "exclusive") notifyExclusiveListeners();
    });
  }
}

function acquireChapterStorageOperation(
  mode: ChapterStorageOperationMode,
  scope: ChapterStorageOperationScope,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const normalizedScope = normalizeScope(scope);
  return new Promise<() => void>((resolve, reject) => {
    const request: ChapterStorageOperationRequest = {
      mode,
      scope: normalizedScope,
      state: "pending",
      resolve,
      signal,
    };
    if (signal) {
      request.abortListener = () => {
        if (request.state !== "pending") return;
        removeRequest(request);
        reject(abortReason(signal));
        drainRequests();
        if (request.mode === "exclusive") notifyExclusiveListeners();
      };
      signal.addEventListener("abort", request.abortListener, { once: true });
    }
    requests.push(request);
    drainRequests();
    if (request.mode === "exclusive") notifyExclusiveListeners();
  });
}

export async function waitForChapterStorageOperation(
  sourceId: string,
  signal?: AbortSignal,
): Promise<void> {
  const release = await acquireChapterStorageOperation(
    "wait",
    { kind: "sources", sourceIds: [sourceId] },
    signal,
  );
  try {
    if (signal?.aborted) throw abortReason(signal);
  } finally {
    release();
  }
}

export async function runExclusiveChapterStorageOperation<T>(
  scope: ChapterStorageOperationScope,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireChapterStorageOperation(
    "exclusive",
    scope,
    signal,
  );
  try {
    if (signal?.aborted) throw abortReason(signal);
    return await run();
  } finally {
    release();
  }
}
