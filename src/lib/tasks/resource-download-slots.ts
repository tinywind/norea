import { getResourceDownloadConcurrency } from "../../store/browse";

export type ResourceDownloadPriority = "background" | "foreground";

export interface ResourceDownloadSlotLease {
  release: () => void;
}

interface ResourceDownloadSlotRequest {
  cleanup: () => void;
  reject: (error: unknown) => void;
  resolve: (lease: ResourceDownloadSlotLease | null) => void;
  shouldStart: () => boolean;
}

interface AcquireResourceDownloadSlotOptions {
  priority: ResourceDownloadPriority;
  shouldStart?: () => boolean;
  signal?: AbortSignal;
}

function normalizedResourceDownloadConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function resourceDownloadAbortError(): DOMException {
  return new DOMException("Resource download was cancelled.", "AbortError");
}

export class ResourceDownloadSlotScheduler {
  private activeCount = 0;
  private readonly backgroundQueue: ResourceDownloadSlotRequest[] = [];
  private readonly foregroundQueue: ResourceDownloadSlotRequest[] = [];

  constructor(
    private readonly readConcurrency: () => number =
      getResourceDownloadConcurrency,
  ) {}

  acquire({
    priority,
    shouldStart = () => true,
    signal,
  }: AcquireResourceDownloadSlotOptions): Promise<
    ResourceDownloadSlotLease | null
  > {
    if (signal?.aborted) {
      return Promise.reject(resourceDownloadAbortError());
    }

    return new Promise((resolve, reject) => {
      const queue =
        priority === "foreground"
          ? this.foregroundQueue
          : this.backgroundQueue;
      let abortListener: (() => void) | undefined;
      const request: ResourceDownloadSlotRequest = {
        cleanup: () => {
          if (abortListener) {
            signal?.removeEventListener("abort", abortListener);
          }
        },
        reject,
        resolve,
        shouldStart,
      };
      abortListener = () => {
        const index = queue.indexOf(request);
        if (index < 0) return;
        queue.splice(index, 1);
        request.cleanup();
        reject(resourceDownloadAbortError());
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      queue.push(request);
      this.drain();
    });
  }

  private drain(): void {
    const concurrency = normalizedResourceDownloadConcurrency(
      this.readConcurrency(),
    );
    while (this.activeCount < concurrency) {
      const request =
        this.foregroundQueue.shift() ?? this.backgroundQueue.shift();
      if (!request) return;
      request.cleanup();

      let shouldStart: boolean;
      try {
        shouldStart = request.shouldStart();
      } catch (error) {
        request.reject(error);
        continue;
      }
      if (!shouldStart) {
        request.resolve(null);
        continue;
      }

      this.activeCount += 1;
      let released = false;
      request.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.drain();
        },
      });
    }
  }
}

export const resourceDownloadSlots = new ResourceDownloadSlotScheduler();
