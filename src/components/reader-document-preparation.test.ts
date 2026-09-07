import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedReaderDocument } from "./reader-document";
import type {
  ReaderDocumentWorkerRequest,
  ReaderDocumentWorkerResponse,
} from "./reader-document-worker";

const { prepareReaderDocument } = vi.hoisted(() => ({
  prepareReaderDocument:
    vi.fn<(html: string, bionicReading: boolean) => PreparedReaderDocument>(),
}));

vi.mock("./reader-document", () => ({ prepareReaderDocument }));

function preparedDocument(html: string): PreparedReaderDocument {
  return {
    html,
    virtualDocument: {
      contentClassName: "reader-content",
      segments: [],
      staticHtml: "",
    },
  };
}

class PreparationWorker {
  static instances: PreparationWorker[] = [];
  onmessage: ((event: MessageEvent<ReaderDocumentWorkerResponse>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request?: ReaderDocumentWorkerRequest;
  terminate = vi.fn();
  postMessage = vi.fn((request: ReaderDocumentWorkerRequest) => {
    this.request = request;
  });

  constructor() {
    PreparationWorker.instances.push(this);
  }

  complete(result: PreparedReaderDocument) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: { id: this.request!.id, result },
      }),
    );
  }
}

let preparation: typeof import("./reader-document-preparation");

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  prepareReaderDocument.mockReset();
  prepareReaderDocument.mockImplementation((html) => preparedDocument(html));
  PreparationWorker.instances = [];
  vi.stubGlobal("Worker", PreparationWorker);
  preparation = await import("./reader-document-preparation");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reader document preparation", () => {
  it("shares pending preparation and reuses its completed document", async () => {
    const first = preparation.prepareReaderDocumentAsync("<p>Chapter</p>", false);
    const second = preparation.prepareReaderDocumentAsync("<p>Chapter</p>", false);
    const result = preparedDocument("<p>Prepared chapter</p>");

    expect(PreparationWorker.instances).toHaveLength(1);
    PreparationWorker.instances[0]!.complete(result);

    await expect(first).resolves.toBe(result);
    await expect(second).resolves.toBe(result);
    expect(preparation.getPreparedReaderDocument("<p>Chapter</p>", false)).toBe(
      result,
    );
    await expect(
      preparation.prepareReaderDocumentAsync("<p>Chapter</p>", false),
    ).resolves.toBe(result);
    expect(PreparationWorker.instances).toHaveLength(1);
    expect(PreparationWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(prepareReaderDocument).not.toHaveBeenCalled();
  });

  it("keeps different HTML and bionic reading settings separate", async () => {
    const requests = [
      preparation.prepareReaderDocumentAsync("<p>Chapter</p>", false),
      preparation.prepareReaderDocumentAsync("<p>Chapter</p>", true),
      preparation.prepareReaderDocumentAsync("<p>Changed chapter</p>", false),
    ];

    expect(PreparationWorker.instances).toHaveLength(3);
    for (const worker of PreparationWorker.instances) {
      worker.complete(preparedDocument(worker.request!.html));
    }
    await Promise.all(requests);
  });

  it("retains only the four most recently used completed documents", async () => {
    for (let index = 0; index < 4; index += 1) {
      const request = preparation.prepareReaderDocumentAsync(String(index), false);
      PreparationWorker.instances[index]!.complete(
        preparedDocument(String(index)),
      );
      await request;
    }
    expect(preparation.getPreparedReaderDocument("0", false)).toBeDefined();
    const fifth = preparation.prepareReaderDocumentAsync("4", false);
    PreparationWorker.instances[4]!.complete(preparedDocument("4"));
    await fifth;

    expect(preparation.getPreparedReaderDocument("0", false)).toBeDefined();
    expect(preparation.getPreparedReaderDocument("1", false)).toBeUndefined();
    expect(preparation.getPreparedReaderDocument("4", false)).toBeDefined();
  });

  it("cancels one subscriber without interrupting another reader", async () => {
    const controller = new AbortController();
    const first = preparation.prepareReaderDocumentAsync(
      "Chapter",
      false,
      controller.signal,
    );
    const second = preparation.prepareReaderDocumentAsync("Chapter", false);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await rejected;
    expect(PreparationWorker.instances[0]!.terminate).not.toHaveBeenCalled();
    const result = preparedDocument("Chapter");
    PreparationWorker.instances[0]!.complete(result);
    await expect(second).resolves.toBe(result);
  });

  it("terminates abandoned work without caching or synchronous fallback", async () => {
    const controller = new AbortController();
    const request = preparation.prepareReaderDocumentAsync(
      "Chapter",
      false,
      controller.signal,
    );
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(0);

    expect(PreparationWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(prepareReaderDocument).not.toHaveBeenCalled();
    expect(preparation.getPreparedReaderDocument("Chapter", false)).toBeUndefined();
    const retry = preparation.prepareReaderDocumentAsync("Chapter", false);
    expect(PreparationWorker.instances).toHaveLength(2);
    PreparationWorker.instances[1]!.complete(preparedDocument("Chapter"));
    await retry;
  });

  it("discards a worker reply that arrives after every subscriber cancels", async () => {
    const controller = new AbortController();
    const request = preparation.prepareReaderDocumentAsync(
      "Chapter",
      false,
      controller.signal,
    );
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    PreparationWorker.instances[0]!.complete(preparedDocument("Chapter"));
    await rejected;

    expect(PreparationWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(preparation.getPreparedReaderDocument("Chapter", false)).toBeUndefined();
    expect(prepareReaderDocument).not.toHaveBeenCalled();
  });

  it("promotes prefetched work to the current reader during effect cleanup", async () => {
    const controller = new AbortController();
    const prefetched = preparation.prepareReaderDocumentAsync(
      "Next chapter",
      false,
      controller.signal,
    );
    const rejected = expect(prefetched).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    const current = preparation.prepareReaderDocumentAsync("Next chapter", false);
    await rejected;
    await vi.advanceTimersByTimeAsync(0);

    expect(PreparationWorker.instances).toHaveLength(1);
    expect(PreparationWorker.instances[0]!.terminate).not.toHaveBeenCalled();
    const result = preparedDocument("Next chapter");
    PreparationWorker.instances[0]!.complete(result);
    await expect(current).resolves.toBe(result);
  });

  it("does not start work for an already cancelled subscriber", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      preparation.prepareReaderDocumentAsync("Chapter", false, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(PreparationWorker.instances).toHaveLength(0);
    expect(prepareReaderDocument).not.toHaveBeenCalled();
  });

  it("prepares the document synchronously when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);

    await expect(
      preparation.prepareReaderDocumentAsync("Chapter", true),
    ).resolves.toEqual(preparedDocument("Chapter"));
    expect(prepareReaderDocument).toHaveBeenCalledWith("Chapter", true);
  });

  it.each(["error", "messageerror", "response"])(
    "falls back when the worker reports %s",
    async (failure) => {
      const request = preparation.prepareReaderDocumentAsync("Chapter", false);
      const worker = PreparationWorker.instances[0]!;
      if (failure === "response") {
        worker.onmessage?.(
          new MessageEvent("message", {
            data: { id: worker.request!.id, error: "Preparation failed" },
          }),
        );
      } else if (failure === "error") {
        worker.onerror?.();
      } else {
        worker.onmessageerror?.();
      }

      await expect(request).resolves.toEqual(preparedDocument("Chapter"));
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(prepareReaderDocument).toHaveBeenCalledOnce();
    },
  );

  it("falls back after an unresponsive worker reaches its timeout", async () => {
    const request = preparation.prepareReaderDocumentAsync("Chapter", false);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(request).resolves.toEqual(preparedDocument("Chapter"));
    expect(PreparationWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(prepareReaderDocument).toHaveBeenCalledOnce();
  });

  it("propagates synchronous preparation failures without caching them", async () => {
    vi.stubGlobal("Worker", undefined);
    prepareReaderDocument.mockImplementation(() => {
      throw new Error("Malformed document");
    });

    await expect(
      preparation.prepareReaderDocumentAsync("Chapter", false),
    ).rejects.toThrow("Malformed document");
    expect(preparation.getPreparedReaderDocument("Chapter", false)).toBeUndefined();
  });
});
