import { throwIfAborted } from "../abort";
import { takeCapturedMediaHandle, type PluginHttpInit } from "../http";
import { isSourceAccessRequiredError } from "../plugins/source-access";
import { TASK_PAUSE_ABORT_MESSAGE } from "../tasks/scheduler";
import { isAndroidRuntime } from "../tauri-runtime";
import { isMediaAbortError } from "./errors";

export const CHAPTER_MEDIA_CANCELLED_MESSAGE =
  "Chapter media download was cancelled.";

interface ChapterMediaDownloadSessionOptions {
  total: number;
  onProgress?: (progress: { current: number; total: number }) => void;
  shouldYield?: () => boolean;
  signal?: AbortSignal;
}

export class ChapterMediaDownloadSession {
  private completed = 0;
  private terminalError: unknown;
  private acquisitionQueue = Promise.resolve();
  private updateQueue = Promise.resolve();

  constructor(private readonly options: ChapterMediaDownloadSessionOptions) {}

  get failed(): boolean {
    return this.terminalError !== undefined;
  }

  fail(error: unknown): void {
    this.terminalError ??= error;
  }

  throwIfStopped(): void {
    if (this.failed) throw this.terminalError;
    throwIfAborted(this.options.signal, CHAPTER_MEDIA_CANCELLED_MESSAGE);
    if (this.options.shouldYield?.()) {
      throw new DOMException(TASK_PAUSE_ABORT_MESSAGE, "AbortError");
    }
  }

  reportProgress(): void {
    this.completed += 1;
    try {
      this.options.onProgress?.({
        current: this.completed,
        total: this.options.total,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  async runUpdate(update: () => Promise<void>): Promise<void> {
    const pending = this.updateQueue.then(update);
    this.updateQueue = pending.catch(() => undefined);
    await pending;
  }

  async acquireCapturedMedia(
    url: string,
    request: PluginHttpInit,
  ): Promise<{
    capturedHandle: Awaited<ReturnType<typeof takeCapturedMediaHandle>>;
    releaseFallback?: () => void;
  }> {
    if (isAndroidRuntime()) {
      // Android fetches are independent and have no desktop response handles.
      this.throwIfStopped();
      return { capturedHandle: null };
    }
    const previous = this.acquisitionQueue;
    let released = false;
    let resolveNext!: () => void;
    this.acquisitionQueue = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const release = (): void => {
      if (released) return;
      released = true;
      resolveNext();
    };
    await previous;
    try {
      this.throwIfStopped();
      const capturedHandle = await takeCapturedMediaHandle(url, request);
      if (capturedHandle) {
        release();
        return { capturedHandle };
      }
      return { capturedHandle: null, releaseFallback: release };
    } catch (error) {
      if (isMediaAbortError(error) || isSourceAccessRequiredError(error)) {
        this.fail(error);
      }
      release();
      throw error;
    }
  }
}
