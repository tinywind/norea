import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSiteBrowserStore } from "../../store/site-browser";
import type { SourceTaskSpec, TaskRunContext } from "./scheduler";

const schedulerMocks = vi.hoisted(() => ({
  enqueueSource: vi.fn(),
}));

vi.mock("./scheduler", () => ({
  taskScheduler: { enqueueSource: schedulerMocks.enqueueSource },
}));

import {
  enqueueSourceAccessBrowserTask,
  enqueueSourceTask,
} from "./source-tasks";

let capturedSpec: SourceTaskSpec<unknown> | null;
let resolveScheduledTask: (value: unknown) => void;

function runContext(confirmSourceAccess: () => boolean): TaskRunContext {
  return {
    confirmSourceAccess,
    executor: "pool:0",
    setDetail: vi.fn(),
    setProgress: vi.fn(),
    signal: new AbortController().signal,
    taskId: "task-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedSpec = null;
  useSiteBrowserStore.getState().hide();
  const promise = new Promise<unknown>((resolve) => {
    resolveScheduledTask = resolve;
  });
  schedulerMocks.enqueueSource.mockImplementation(
    (spec: SourceTaskSpec<unknown>) => {
      capturedSpec = spec;
      return { id: "task-1", promise };
    },
  );
});

describe("enqueueSourceTask", () => {
  it("scopes source work by exact hostname and confirms after a successful run", async () => {
    const confirmSourceAccess = vi.fn(() => true);
    const run = vi.fn(async () => "done");

    enqueueSourceTask({
      kind: "source.search",
      plugin: {
        getBaseUrl: () => "https://Reader.Source.Test:8443/",
        id: "source-a",
        name: "Source A",
      },
      run,
      title: "Search",
    });

    expect(capturedSpec?.sourceAccessScopeKey).toBe("site:reader.source.test");
    expect(capturedSpec?.resolveSourceAccessUrl).toBeUndefined();
    await expect(
      capturedSpec?.run(runContext(confirmSourceAccess)),
    ).resolves.toBe("done");
    expect(confirmSourceAccess).toHaveBeenCalledOnce();
  });

  it("does not confirm access when source work fails", async () => {
    const confirmSourceAccess = vi.fn(() => true);
    const failure = new Error("source failed");

    enqueueSourceTask({
      kind: "source.search",
      plugin: {
        getBaseUrl: () => "https://source.test/",
        id: "source-a",
        name: "Source A",
      },
      run: async () => {
        throw failure;
      },
      title: "Search",
    });

    await expect(
      capturedSpec?.run(runContext(confirmSourceAccess)),
    ).rejects.toBe(failure);
    expect(confirmSourceAccess).not.toHaveBeenCalled();
  });

  it("does not confirm access after clearing source cookies", async () => {
    const confirmSourceAccess = vi.fn(() => true);

    enqueueSourceTask({
      kind: "source.clearCookies",
      plugin: {
        getBaseUrl: () => "https://source.test/",
        id: "source-a",
        name: "Source A",
      },
      run: async () => 1,
      title: "Clear cookies",
    });

    await expect(
      capturedSpec?.run(runContext(confirmSourceAccess)),
    ).resolves.toBe(1);
    expect(confirmSourceAccess).not.toHaveBeenCalled();
  });
});

describe("enqueueSourceAccessBrowserTask", () => {
  it("binds the challenge context and browser outcome to its scheduler task", async () => {
    const block = {
      challenge: { kind: "cloudflare" as const, url: "https://source.test/cf" },
      detectedAt: 1,
      revision: 2,
      scopeKey: "site:source.test",
      sourceIds: ["source-a"],
      verificationRequested: false,
    };

    const handle = enqueueSourceAccessBrowserTask(
      {
        getBaseUrl: () => "https://source.test/",
        id: "source-a",
        name: "Source A",
      },
      block,
      "Verify source",
    );

    expect(useSiteBrowserStore.getState().context).toEqual({
      mode: "source-access",
      challenge: block.challenge,
      revision: 2,
      scopeKey: "site:source.test",
      sourceName: "Source A",
    });
    useSiteBrowserStore
      .getState()
      .startLoading(block.challenge.url, handle.id);
    useSiteBrowserStore.getState().markReady(handle.id);
    useSiteBrowserStore.getState().complete(handle.id, block.revision, "verify");
    resolveScheduledTask(undefined);
    await expect(handle.promise).resolves.toBe("verify");
  });

  it("rejects a browser completion from another block revision", async () => {
    const block = {
      challenge: { kind: "captcha" as const, url: "https://source.test/cf" },
      detectedAt: 1,
      revision: 5,
      scopeKey: "site:source.test",
      sourceIds: ["source-a"],
      verificationRequested: false,
    };
    const handle = enqueueSourceAccessBrowserTask(
      {
        getBaseUrl: () => "https://source.test/",
        id: "source-a",
        name: "Source A",
      },
      block,
      "Verify source",
    );
    useSiteBrowserStore.setState({
      completion: {
        outcome: "verify",
        revision: block.revision - 1,
        scopeKey: block.scopeKey,
        taskId: handle.id,
      },
    });

    resolveScheduledTask(undefined);

    await expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
