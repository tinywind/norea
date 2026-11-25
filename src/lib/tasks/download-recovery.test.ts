import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDownloadRecoveryPolicy, useDownloadRecoveryStore } from "../../store/download-recovery";
import { ContentServerTransportError } from "../content-sync/client";
import { ChapterStorageError } from "../chapter-storage-error";
import { ChapterMediaIncompleteError } from "../chapter-media/errors";
import { HttpStatusError } from "../http/status-error";
import { SourceAccessRequiredError } from "../plugins/source-access";
import type { TaskRunContext } from "./task-types";
import {
  DOWNLOAD_RECOVERY_STORAGE_KEY, DownloadRecoveryController, DownloadRecoveryHoldError,
  DownloadRecoveryNextProfileError, decideDownloadRecovery, downloadRecoveryKey,
} from "./download-recovery";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
const job = { id: 11, pluginId: "source", title: "Chapter eleven" };
const url = "https://example.test/chapter/11";
const policy = (value: Record<string, unknown> = {}) => normalizeDownloadRecoveryPolicy({ retryDelaySeconds: 5, ...value });
const zero = { retries: 0, profileChanges: 0, siteResetCount: 0 };
const context = (signal = new AbortController().signal): TaskRunContext => ({
  signal, taskId: "task-11", setDetail: vi.fn(), setProgress: vi.fn(),
});
const failure = () => new HttpStatusError(503, "Unavailable");
const forbidden = () => new HttpStatusError(403, "Forbidden");
const tick = async (ms = 5000) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => { vi.useFakeTimers(); useDownloadRecoveryStore.getState().setPolicy(policy()); });
afterEach(() => { vi.useRealTimers(); });

describe("recovery decisions", () => {
  it("keeps conservative defaults, skips only 404, and never retries storage or parse failures", () => {
    const decide = (error: unknown) => decideDownloadRecovery(policy(), error, zero, { vpn: true, canResetSite: true }).action;
    expect([decide(forbidden()), decide(failure()), decide(new HttpStatusError(429, "Wait")), decide(new HttpStatusError(404, "Missing"))])
      .toEqual(["pause", "pause", "pause", "skip"]);
    const enabled = policy({ forbiddenAction: "resetSite", transientAction: "nextProfile", rateLimitAction: "retry" });
    expect(decideDownloadRecovery(enabled, new ChapterStorageError("Write content", new Error("Disk full")), zero, { vpn: true, canResetSite: true }).action).toBe("pause");
    expect(decideDownloadRecovery(enabled, new SyntaxError("Invalid chapter"), zero, { vpn: true, canResetSite: true }).action).toBe("pause");
  });

  it("applies retry, reset, and profile budgets to every extra attempt", () => {
    expect(decideDownloadRecovery(policy({ forbiddenAction: "resetSite" }), forbidden(), { ...zero, siteResetCount: 1 }, { vpn: false, canResetSite: true }))
      .toMatchObject({ action: "pause", reason: "budget" });
    expect(decideDownloadRecovery(policy({ transientAction: "nextProfile" }), failure(), zero, { vpn: false, canResetSite: true }))
      .toMatchObject({ action: "pause", reason: "unsupported" });
    expect(decideDownloadRecovery(policy({ transientAction: "nextProfile" }), failure(), { ...zero, profileChanges: 1 }, { vpn: true, canResetSite: true }))
      .toMatchObject({ action: "pause", reason: "budget" });
    expect(decideDownloadRecovery(policy({ transientAction: "retry" }), failure(), { ...zero, retries: 2 }, { vpn: true, canResetSite: true }))
      .toMatchObject({ action: "pause", reason: "budget" });
  });

  it("honors a longer Retry-After and recognizes rate-limited media aggregates", () => {
    const error = Object.assign(new HttpStatusError(429, "Wait"), { retryAfterMs: 45_000 });
    expect(decideDownloadRecovery(policy({ rateLimitAction: "retry" }), error, zero, { vpn: false, canResetSite: true }))
      .toMatchObject({ action: "retry", delayMs: 45_000 });
    const media = new ChapterMediaIncompleteError([{ status: 429, message: "HTTP 429", url: "https://example.test/image", retryAfterMs: 60_000 }]);
    expect(decideDownloadRecovery(policy({ rateLimitAction: "retry" }), media, zero, { vpn: false, canResetSite: true }))
      .toMatchObject({ action: "retry", delayMs: 60_000 });
  });
});

describe("durable recovery execution", () => {

  it("does not recover the source or choose a VPN profile after a server transport failure", async () => {
    const storage = memoryStorage();
    const controller = new DownloadRecoveryController(storage);
    const transport = new ContentServerTransportError("Content server connection failed (HTTP 403).");
    const operation = vi.fn(async () => "source body");
    const resetSite = vi.fn(async () => undefined);
    const profileId = vi.fn(() => "vpn-a");
    await expect(controller.run({
      job, url, vpn: true, resetSite, profileId,
      policy: policy({ forbiddenAction: "resetSite", transientAction: "nextProfile" }),
      beforeAttempt: async () => { throw transport; },
    }, context(), operation)).rejects.toBe(transport);
    expect(operation).not.toHaveBeenCalled();
    expect(resetSite).not.toHaveBeenCalled();
    expect(profileId).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual([]);
    const persisted = JSON.parse(storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY) ?? '{"version":2,"policies":[],"sourcePolicies":{},"policyOverrides":[],"episodes":[],"siteResets":[]}');
    expect(persisted.jobs).toBeUndefined();
    expect(persisted.policies).toEqual([]);
    expect(persisted.sourcePolicies).toEqual({});
    expect(persisted.policyOverrides).toEqual([]);
    expect(persisted.episodes).toEqual([]);
  });

  it.each(["resetSite", "nextProfile"] as const)("rechecks the server after a retry delay before %s touches the source", async action => {
    const controller = new DownloadRecoveryController(memoryStorage());
    let serverAvailable = false;
    const resetSite = vi.fn(async () => undefined);
    const operation = vi.fn(async () => { throw action === "resetSite" ? forbidden() : failure(); });
    const beforeAttempt = vi.fn(async () => serverAvailable
      ? { handled: true as const, value: "server copy" }
      : { handled: false as const });
    const result = controller.run<string>({ job, url, beforeAttempt, resetSite, vpn: true,
      profileId: () => "vpn-a", policy: policy({ forbiddenAction: "resetSite", transientAction: "nextProfile" }),
    }, context(), operation).catch((error: unknown) => error);
    await tick(0);
    expect(operation).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject([{ action, status: "waiting" }]);
    expect(resetSite).not.toHaveBeenCalled();
    serverAvailable = true;
    await tick();
    expect(await result).toBe("server copy");
    expect(operation).toHaveBeenCalledOnce();
    expect(resetSite).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual([]);
  });

  it("limits automatic retries and retains the terminal episode", async () => {
    const controller = new DownloadRecoveryController(memoryStorage());
    const operation = vi.fn(async () => { throw failure(); });
    const result = controller.run({ job, url, policy: policy({ transientAction: "retry" }) }, context(), operation);
    const rejected = expect(result).rejects.toThrow("HTTP 503");
    await tick();
    expect(operation).toHaveBeenCalledTimes(2);
    await tick();
    await rejected;
    expect(operation).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject([{ status: "held", retries: 2, nextRetryAt: null }]);
  });

  it("persists a reserved retry and deadline before it executes, then restores that reservation", async () => {
    const storage = memoryStorage();
    const first = new DownloadRecoveryController(storage);
    const abort = new AbortController();
    const run = first.run({ job, url, policy: policy({ transientAction: "retry" }) }, context(abort.signal), async () => { throw failure(); });
    const aborted = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await tick(0);
    const before = first.getSnapshot()[0]!;
    expect(before).toMatchObject({ retries: 1, status: "waiting" });
    expect(JSON.parse(storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!).episodes[0].nextRetryAt).toBe(before.nextRetryAt);
    abort.abort(new DOMException("Paused", "AbortError"));
    await aborted;
    const restored = new DownloadRecoveryController(storage);
    const operation = vi.fn(async () => "done");
    const result = restored.run({ job, url, policy: policy() }, context(), operation);
    await tick(4999);
    expect(operation).not.toHaveBeenCalled();
    await tick(1);
    expect(await result).toBe("done");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(restored.getSnapshot()).toEqual([]);
  });

  it("performs at most one site reset even when the server returns another 403", async () => {
    const controller = new DownloadRecoveryController(memoryStorage());
    const resetSite = vi.fn(async () => undefined);
    const operation = vi.fn(async () => { throw forbidden(); });
    const result = controller.run({ job, url, resetSite, policy: policy({ forbiddenAction: "resetSite" }) }, context(), operation);
    const rejected = expect(result).rejects.toThrow("HTTP 403");
    await tick();
    await rejected;
    expect(resetSite).toHaveBeenCalledExactlyOnceWith("source", "https://example.test");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject([{ status: "held", retries: 1, siteResetCount: 1 }]);
  });

  it("does not replay a reset interrupted by an app restart", async () => {
    const storage = memoryStorage();
    const controller = new DownloadRecoveryController(storage);
    const abort = new AbortController();
    let finishReset!: () => void;
    const resetSite = vi.fn(() => new Promise<void>(resolve => { finishReset = resolve; }));
    const result = controller.run({ job, url, resetSite, policy: policy({ forbiddenAction: "resetSite" }) }, context(abort.signal), async () => { throw forbidden(); });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    expect(controller.getSnapshot()[0]?.status).toBe("resetting");
    const restored = new DownloadRecoveryController(storage);
    const operation = vi.fn(async () => "unsafe");
    await expect(restored.run({ job, url, resetSite }, context(), operation)).rejects.toBeInstanceOf(DownloadRecoveryHoldError);
    expect(operation).not.toHaveBeenCalled();
    expect(resetSite).toHaveBeenCalledTimes(1);
    abort.abort(new DOMException("Stopped", "AbortError"));
    finishReset();
    await rejected;
  });

  it("serializes shared-origin attempts and coalesces site-reset ownership across source IDs", async () => {
    const controller = new DownloadRecoveryController(memoryStorage());
    const resetSite = vi.fn(async () => undefined);
    const operation = vi.fn(async () => { throw forbidden(); });
    const options = { url, resetSite, policy: policy({ forbiddenAction: "resetSite" }) };
    const a = controller.run({ ...options, job }, context(), operation);
    const b = controller.run({ ...options, job: { ...job, id: 12, pluginId: "other-source" } }, context(), operation);
    const results = Promise.allSettled([a, b]);
    await tick();
    expect((await results).every(result => result.status === "rejected")).toBe(true);
    expect(resetSite).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("keeps the hold when reset fails and never runs the next source attempt", async () => {
    const controller = new DownloadRecoveryController(memoryStorage());
    const operation = vi.fn(async () => { throw forbidden(); });
    const result = controller.run({
      job, url, policy: policy({ forbiddenAction: "resetSite" }),
      resetSite: async () => { throw new Error("Shared profile is busy"); },
    }, context(), operation);
    const rejected = expect(result).rejects.toThrow("Site reset failed");
    await tick();
    await rejected;
    expect(operation).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject([{ status: "held", siteResetCount: 1 }]);
  });

  it("requests only an unused VPN profile and preserves the episode across the handover", async () => {
    const controller = new DownloadRecoveryController(memoryStorage());
    const options = { job, url, vpn: true, policy: policy({ transientAction: "nextProfile" }) };
    const initial = controller.run({ ...options, profileId: () => "vpn-a" }, context(), async () => { throw failure(); });
    const rejected = expect(initial).rejects.toBeInstanceOf(DownloadRecoveryNextProfileError);
    await tick();
    await rejected;
    expect(controller.usedProfiles(downloadRecoveryKey(job))).toEqual(["vpn-a"]);
    const sameProfile = vi.fn(async () => "unsafe");
    await expect(controller.run({ ...options, profileId: () => "vpn-a" }, context(), sameProfile)).rejects.toBeInstanceOf(DownloadRecoveryNextProfileError);
    expect(sameProfile).not.toHaveBeenCalled();
    const nextProfile = vi.fn(async () => "downloaded");
    expect(await controller.run({ ...options, profileId: () => "vpn-b" }, context(), nextProfile)).toBe("downloaded");
    expect(nextProfile).toHaveBeenCalledTimes(1);
  });

  it("preserves settings for already queued work and adopts new settings only on explicit resume", async () => {
    const controller = new DownloadRecoveryController(memoryStorage());
    controller.register([job], policy());
    const operation = vi.fn(async () => { throw failure(); });
    await expect(controller.run({ job, url, policy: policy({ transientAction: "retry" }) }, context(), operation)).rejects.toThrow("HTTP 503");
    expect(operation).toHaveBeenCalledTimes(1);
    useDownloadRecoveryStore.getState().setPolicy(policy({ transientAction: "retry", maxRetries: 1 }));
    controller.resume("source");
    const result = controller.run({ job, url }, context(), operation);
    const rejected = expect(result).rejects.toThrow("HTTP 503");
    await tick();
    await rejected;
    expect(operation).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()[0]).toMatchObject({ retries: 1, maxRetries: 1 });
  });

  it("gives user pause/cancel precedence over a pending retry", async () => {
    const controller = new DownloadRecoveryController(memoryStorage());
    const abort = new AbortController();
    const operation = vi.fn(async () => { throw failure(); });
    const result = controller.run({ job, url, policy: policy({ transientAction: "retry" }) }, context(abort.signal), operation);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await tick(1000);
    abort.abort(new DOMException("Task was paused.", "AbortError"));
    await rejected;
    await tick(20_000);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()[0]).toMatchObject({ retries: 1, status: "waiting" });
  });

  it("never retries storage failures, and treats inability to persist a reservation as a storage failure", async () => {
    const controller = new DownloadRecoveryController(memoryStorage());
    const storageFailure = new ChapterStorageError("Write chapter", new Error("Database full"));
    await expect(controller.run({ job, url, policy: policy({ transientAction: "retry" }) }, context(), async () => { throw storageFailure; })).rejects.toBe(storageFailure);
    expect(controller.getSnapshot()).toEqual([]);
    const unavailable = new DownloadRecoveryController(null);
    const operation = vi.fn(async () => { throw failure(); });
    await expect(unavailable.run({ job, url, policy: policy({ transientAction: "retry" }) }, context(), operation)).rejects.toBeInstanceOf(ChapterStorageError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retains partial 404 failures as failures and turns the pause policy into a real hold", async () => {
    const partial = new ChapterMediaIncompleteError([{ status: 404, message: "HTTP 404", url: "https://example.test/image" }]);
    const skipped = new DownloadRecoveryController(memoryStorage());
    await expect(skipped.run({ job, url, policy: policy() }, context(), async () => { throw partial; })).rejects.toBe(partial);
    expect(skipped.getSnapshot()).toEqual([]);
    const held = new DownloadRecoveryController(memoryStorage());
    await expect(held.run({ job, url, policy: policy({ notFoundAction: "pause" }) }, context(), async () => { throw partial; })).rejects.toBeInstanceOf(DownloadRecoveryHoldError);
    expect(held.getSnapshot()[0]?.status).toBe("held");
  });

  it("retries transient incomplete media when configured and clears its episode once exhausted so manual retry works", async () => {
    const partial = new ChapterMediaIncompleteError([
      { fileName: "0009.jpg", message: "scraper: browser fetch to https://img.goodtoon9001.top timed out after 30000ms", url: "https://img.goodtoon9001.top/0009.jpg" },
    ]);
    const paused = new DownloadRecoveryController(memoryStorage());
    await expect(paused.run({ job, url, policy: policy() }, context(), async () => { throw partial; })).rejects.toBe(partial);
    expect(paused.getSnapshot()).toEqual([]);

    const retried = new DownloadRecoveryController(memoryStorage());
    const operation = vi.fn(async () => { throw partial; });
    const run = retried.run({ job, url, policy: policy({ transientAction: "retry", maxRetries: 1 }) }, context(), operation);
    const rejected = expect(run).rejects.toBe(partial);
    await tick();
    await rejected;
    expect(operation).toHaveBeenCalledTimes(2);
    expect(retried.getSnapshot()).toEqual([]);
  });

  it("holds mixed 404 and transient incomplete media when notFoundAction is pause", async () => {
    const mixed = new ChapterMediaIncompleteError([
      { status: 404, message: "HTTP 404", url: "https://example.test/missing" },
      { status: 503, message: "HTTP 503", url: "https://example.test/unavailable" },
    ]);
    const held = new DownloadRecoveryController(memoryStorage());
    await expect(held.run({ job, url, policy: policy({ notFoundAction: "pause" }) }, context(), async () => { throw mixed; }))
      .rejects.toBeInstanceOf(DownloadRecoveryHoldError);
    expect(held.getSnapshot()[0]?.status).toBe("held");
  });
});


it("skips a missing media resource while applying the selected policy to the remaining failures", () => {
  const media = new ChapterMediaIncompleteError([
    { status: 404, message: "HTTP 404", url: "https://example.test/missing" },
    { status: 503, message: "HTTP 503", url: "https://example.test/unavailable" },
  ]);
  expect(decideDownloadRecovery(policy({ transientAction: "retry" }), media, zero, { vpn: false, canResetSite: true }).action).toBe("retry");
  expect(decideDownloadRecovery(policy({ transientAction: "retry", notFoundAction: "pause" }), media, zero, { vpn: false, canResetSite: true }).action).toBe("pause");
});

it("uses the 403 policy for an HTTP 403 challenge and keeps non-403 verification manual", () => {
  const challenged = new SourceAccessRequiredError("HTTP 403 verification required", { kind: "cloudflare", url });
  const verification = new SourceAccessRequiredError("Verification required", { kind: "cloudflare", url });
  const enabled = policy({ forbiddenAction: "retry" });
  expect(decideDownloadRecovery(enabled, challenged, zero, { vpn: false, canResetSite: true }).action).toBe("retry");
  expect(decideDownloadRecovery(enabled, verification, zero, { vpn: false, canResetSite: true }).action).toBe("pause");
});

it("retargets a composed chapter's recovery without clearing its persisted hold or retry budget", async () => {
  const storage = memoryStorage();
  const controller = new DownloadRecoveryController(storage);
  controller.register([job]);
  controller.networkLost(downloadRecoveryKey(job), new Error("Original request failed"));
  const held = controller.getSnapshot()[0]!;
  controller.setSource({ ...job, pluginId: "original-source" });
  expect(controller.getSnapshot()[0]).toEqual({ ...held, sourceId: "original-source" });
  const restored = new DownloadRecoveryController(storage);
  expect(restored.getSnapshot()[0]).toEqual({ ...held, sourceId: "original-source" });
  const operation = vi.fn(async () => undefined);
  await expect(restored.run({ job: { ...job, pluginId: "original-source" } }, context(), operation)).rejects.toBeInstanceOf(DownloadRecoveryHoldError);
  expect(operation).not.toHaveBeenCalled();
});

it("forwards a composed source route through recovery and preserves a deferred held attempt", async () => {
  const controller = new DownloadRecoveryController(memoryStorage());
  controller.register([job]);
  controller.networkLost(downloadRecoveryKey(job), new Error("Original request held"));
  const route = { source: { id: "original-source", name: "Original" }, sourceCooldownKey: "chapter.download:original-source" };
  const tryStartSourceAccess = vi.fn(() => false);
  const operation = vi.fn(async () => undefined);
  await controller.run({ job, beforeAttempt: async attempt => {
    controller.setSource({ ...job, pluginId: route.source.id });
    expect(attempt.tryStartSourceAccess!(route)).toBe(false);
    return { handled: true, value: undefined };
  } }, { ...context(), tryStartSourceAccess }, operation);
  expect(tryStartSourceAccess).toHaveBeenCalledExactlyOnceWith(route);
  expect(controller.getSnapshot()).toMatchObject([{ sourceId: "original-source", status: "held" }]);
  expect(operation).not.toHaveBeenCalled();
});

it("applies the rate-limit policy when 429 is mixed with 404 or 503 media failures", () => {
  const mixed = new ChapterMediaIncompleteError([
    { status: 404, message: "HTTP 404", url: "https://example.test/missing" },
    { status: 503, message: "HTTP 503", url: "https://example.test/unavailable" },
    { status: 429, message: "HTTP 429", url: "https://example.test/limited", retryAfterMs: 30_000 },
  ]);
  expect(decideDownloadRecovery(policy({ rateLimitAction: "retry", transientAction: "pause" }), mixed, zero, { vpn: false, canResetSite: true }))
    .toMatchObject({ action: "retry", delayMs: 30_000 });
});

it("preserves an existing recovery episode when beforeAttempt fails", async () => {
  const storage = memoryStorage();
  const controller = new DownloadRecoveryController(storage);
  controller.register([job]);
  controller.networkLost(downloadRecoveryKey(job), new Error("Original failure"));
  const serverFailure = new ContentServerTransportError("Server unreachable");
  await expect(controller.run({
    job,
    beforeAttempt: async () => { throw serverFailure; },
  }, context(), vi.fn(async () => undefined))).rejects.toBe(serverFailure);
  expect(controller.getSnapshot()).toMatchObject([{ key: downloadRecoveryKey(job), status: "held" }]);
});

function quotaError(): Error {
  return new DOMException(
    "Failed to execute 'setItem' on 'Storage': Setting the value of 'download-recovery-runtime' exceeded the quota.",
    "QuotaExceededError",
  );
}

function quotaStorage(maxChars: number, options: { strictReplace?: boolean } = {}) {
  const values = new Map<string, string>();
  const totalChars = () => [...values.values()].reduce((sum, entry) => sum + entry.length, 0);
  return {
    values,
    setItemCalls: 0,
    totalChars,
    seed(key: string, value: string) {
      values.set(key, value);
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      this.setItemCalls++;
      const previous = options.strictReplace ? 0 : (values.get(key)?.length ?? 0);
      if (totalChars() - previous + value.length > maxChars) {
        throw quotaError();
      }
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

describe("bounded persistence, legacy v1 migration, rollback, and pruning", () => {
  it("keeps localStorage compact and avoids QuotaExceededError with 100k+ queued chapters", async () => {
    const storage = quotaStorage(64 * 1024);
    const controller = new DownloadRecoveryController(storage);
    const queuedPolicy = policy({ transientAction: "retry", maxRetries: 1 });
    const batch1 = Array.from({ length: 60_000 }, (_, index) => ({
      id: index + 1,
      pluginId: index % 2 === 0 ? "source-a" : "source-b",
      title: `Chapter ${index + 1} with a long descriptive title`,
    }));
    const batch2 = Array.from({ length: 45_000 }, (_, index) => ({
      id: 60_001 + index,
      pluginId: index % 2 === 0 ? "source-a" : "source-b",
      title: `Chapter ${60_001 + index} with a long descriptive title`,
    }));

    controller.register(batch1, queuedPolicy);
    const writesAfterFirstBatch = storage.setItemCalls;
    const rawAfterFirstBatch = storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!;
    expect(rawAfterFirstBatch.length).toBeLessThan(1_024);
    expect(JSON.parse(rawAfterFirstBatch)).toMatchObject({
      version: 2,
      sourcePolicies: { "source-a": 0, "source-b": 0 },
      policyOverrides: [],
      episodes: [],
      siteResets: [],
    });

    // Adding 45k more jobs with the same policy needs no additional storage write.
    controller.register(batch2, queuedPolicy);
    expect(storage.setItemCalls).toBe(writesAfterFirstBatch);
    expect(storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!.length).toBeLessThan(1_024);

    // Changing settings and queueing a new contiguous batch stores compact ranges only.
    const newerPolicy = policy({ transientAction: "pause" });
    const batch3 = Array.from({ length: 10_000 }, (_, index) => ({
      id: 200_001 + index,
      pluginId: "source-a",
      title: `New Chapter ${200_001 + index}`,
    }));
    controller.register(batch3, newerPolicy);
    const rawMixed = storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!;
    expect(rawMixed.length).toBeLessThan(2_048);
    expect(JSON.parse(rawMixed).policyOverrides).toEqual([
      { sourceId: "source-a", policyIndex: 1, ranges: [[200_001, 210_000]] },
    ]);

    // Across a restart, old queued jobs preserve queuedPolicy and new batch jobs preserve newerPolicy.
    useDownloadRecoveryStore.getState().setPolicy(policy({ transientAction: "pause", forbiddenAction: "retry" }));
    const restarted = new DownloadRecoveryController(storage);
    restarted.restore([batch1[0]!, batch3[0]!]);

    const oldOp = vi.fn(async () => { throw failure(); });
    const oldRun = restarted.run({ job: batch1[0]!, url }, context(), oldOp);
    const oldRejected = expect(oldRun).rejects.toThrow("HTTP 503");
    await tick();
    await oldRejected;
    expect(oldOp).toHaveBeenCalledTimes(2);

    const newOp = vi.fn(async () => { throw failure(); });
    await expect(restarted.run({ job: batch3[0]!, url }, context(), newOp)).rejects.toThrow("HTTP 503");
    expect(newOp).toHaveBeenCalledTimes(1);
  });

  it("caps adversarial non-contiguous policy overrides while preserving active episodes", async () => {
    const storage = quotaStorage(64 * 1024);
    const controller = new DownloadRecoveryController(storage);
    const basePolicy = policy({ transientAction: "pause" });
    const altPolicy = policy({ transientAction: "retry", maxRetries: 1 });
    controller.register([{ id: 1, pluginId: "source-a", title: "Base" }], basePolicy);

    const alternating = Array.from({ length: 3_000 }, (_, index) => ({
      id: (index + 1) * 2,
      pluginId: "source-a",
      title: `Oddly spaced ${index}`,
    }));
    controller.register(alternating, altPolicy);
    const raw = storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!;
    expect(raw.length).toBeLessThan(32 * 1024);
    const parsed = JSON.parse(raw);
    const rangeCount = parsed.policyOverrides.reduce(
      (sum: number, group: { ranges?: unknown[] }) => sum + (group.ranges?.length ?? 0),
      0,
    );
    expect(rangeCount).toBeLessThanOrEqual(1_000);

    // An active recovery episode is still persisted and restored intact.
    const activeJob = { id: 999_999, pluginId: "source-b", title: "Active chapter" };
    controller.register([activeJob], altPolicy);
    const abort = new AbortController();
    const pending = controller.run({ job: activeJob, url }, context(abort.signal), async () => { throw failure(); });
    const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await tick(0);
    abort.abort(new DOMException("Paused", "AbortError"));
    await aborted;

    const restored = new DownloadRecoveryController(storage);
    expect(restored.getSnapshot()).toMatchObject([{ key: downloadRecoveryKey(activeJob), status: "waiting", retries: 1 }]);
  });

  it.each([false, true] as const)(
    "safely compacts an oversized legacy v1 payload (~5.2 MiB, 85k+ jobs) without throwing (strictReplace=%s)",
    (strictReplace) => {
      const fiveMiB = 5 * 1024 * 1024;
      const storage = quotaStorage(fiveMiB, { strictReplace });
      const legacyPolicy = policy({ transientAction: "pause" });
      const legacyJobs = Array.from({ length: 85_202 }, (_, index) => [
        `chapter:${index + 1}`,
        "source-a",
        `Chapter ${index + 1} - Queued Entry Title`,
        0,
      ]);
      const legacyPayload = JSON.stringify({
        version: 1,
        policies: [legacyPolicy],
        jobs: legacyJobs,
        episodes: [],
        siteResets: [],
      });
      expect(legacyPayload.length).toBeGreaterThan(5_000_000);
      storage.seed(DOWNLOAD_RECOVERY_STORAGE_KEY, legacyPayload);
      storage.seed(
        "download-failure-stops",
        JSON.stringify({
          version: 1,
          sourceErrors: {},
          globalError: "Chapter storage failed during Save download recovery state: exceeded the quota.",
        }),
      );

      const controller = new DownloadRecoveryController(storage);
      expect(() => controller.getSnapshot()).not.toThrow();
      expect(controller.getSnapshot()).toEqual([]);

      const compacted = storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!;
      expect(compacted.length).toBeLessThan(1_024);
      expect(JSON.parse(compacted)).toMatchObject({
        version: 2,
        sourcePolicies: { "source-a": 0 },
        policyOverrides: [],
        episodes: [],
        siteResets: [],
      });
      expect(storage.totalChars()).toBeLessThan(2_048);

      // Resuming and clearing global stops now succeed without QuotaExceededError.
      useDownloadRecoveryStore.getState().setPolicy(policy({ transientAction: "retry", maxRetries: 2 }));
      expect(() => controller.resume()).not.toThrow();
      expect(() => storage.setItem("download-failure-stops", JSON.stringify({ version: 1, sourceErrors: {} }))).not.toThrow();
      expect(() => controller.forget(["chapter:1", "chapter:2"], true)).not.toThrow();
    },
  );

  it("preserves active episodes, interrupted holds, siteResets, and mixed policies during legacy v1 migration", async () => {
    const storage = quotaStorage(5 * 1024 * 1024);
    const p0 = policy({ transientAction: "pause" });
    const p1 = policy({ forbiddenAction: "resetSite", transientAction: "retry", maxRetries: 2 });
    const legacyJobs = [
      ...Array.from({ length: 5_000 }, (_, index) => [`chapter:${index + 1}`, "source-a", `Chapter ${index + 1}`, 0]),
      ["chapter:9001", "source-a", "Chapter 9001", 1],
      ["chapter:9002", "source-a", "Chapter 9002", 1],
      ["chapter:9003", "source-b", "Chapter 9003", 1],
    ];
    storage.seed(DOWNLOAD_RECOVERY_STORAGE_KEY, JSON.stringify({
      version: 1,
      policies: [p0, p1],
      jobs: legacyJobs,
      episodes: [
        {
          key: "chapter:9001",
          sourceId: "source-a",
          title: "Chapter 9001",
          origin: "https://example.test",
          status: "waiting",
          action: "retry",
          retries: 1,
          maxRetries: 2,
          nextRetryAt: Date.now() + 5_000,
          profileChanges: 0,
          maxProfileChanges: 1,
          siteResetCount: 0,
          resetApplied: false,
          currentProfileId: null,
          currentProfileHash: null,
          usedProfileIds: [],
          error: "HTTP 503",
        },
        {
          key: "chapter:9003",
          sourceId: "source-b",
          title: "Chapter 9003",
          origin: "https://example.test",
          status: "resetting",
          action: "resetSite",
          retries: 1,
          maxRetries: 2,
          nextRetryAt: null,
          profileChanges: 0,
          maxProfileChanges: 1,
          siteResetCount: 1,
          resetApplied: false,
          currentProfileId: null,
          currentProfileHash: null,
          usedProfileIds: [],
          error: "HTTP 403",
        },
      ],
      siteResets: ["https://example.test"],
    }));

    const controller = new DownloadRecoveryController(storage);
    expect(controller.getSnapshot()).toMatchObject([
      { key: "chapter:9001", status: "waiting", retries: 1, maxRetries: 2 },
      { key: "chapter:9003", status: "held", siteResetCount: 1 },
    ]);
    const migrated = JSON.parse(storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!);
    expect(migrated.version).toBe(2);
    expect(migrated.jobs).toBeUndefined();
    expect(migrated.siteResets).toEqual(["https://example.test"]);
    expect(migrated.policyOverrides).toEqual([{ sourceId: "source-a", policyIndex: 1, ranges: [[9002, 9002]] }]);

    // Interrupted resetting episode stays held; waiting episode respects its policy & deadline;
    // minority non-episode override job 9002 keeps p1 while majority job 1 keeps p0.
    await expect(controller.run({ job: { id: 9003, pluginId: "source-b", title: "Chapter 9003" }, url }, context(), vi.fn(async () => "unsafe")))
      .rejects.toBeInstanceOf(DownloadRecoveryHoldError);
    const op9002 = vi.fn(async () => { throw failure(); });
    const run9002 = controller.run({ job: { id: 9002, pluginId: "source-a", title: "Chapter 9002" }, url }, context(), op9002);
    const rejected9002 = expect(run9002).rejects.toThrow("HTTP 503");
    await tick();
    await tick();
    await rejected9002;
    expect(op9002).toHaveBeenCalledTimes(3);

    const op1 = vi.fn(async () => { throw failure(); });
    await expect(controller.run({ job: { id: 1, pluginId: "source-a", title: "Chapter 1" }, url }, context(), op1)).rejects.toThrow("HTTP 503");
    expect(op1).toHaveBeenCalledTimes(1);
  });

  it("rolls back in-memory mutations when persist throws QuotaExceededError so resume and forget still succeed", async () => {
    const values = new Map<string, string>();
    let failWrites = false;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw quotaError();
        values.set(key, value);
      },
    };
    const controller = new DownloadRecoveryController(storage);
    const existingJob = { id: 1, pluginId: "source-a", title: "Chapter 1" };
    controller.register([existingJob], policy({ transientAction: "pause" }));
    controller.networkLost(downloadRecoveryKey(existingJob), new Error("Temporary outage"));
    expect(controller.getSnapshot()).toMatchObject([{ key: "chapter:1", status: "held" }]);

    // Failing register() for a new source must roll back completely and never poison resume() or forget().
    failWrites = true;
    const poisonedJob = { id: 2, pluginId: "source-b", title: "Chapter 2" };
    expect(() => controller.register([poisonedJob], policy({ transientAction: "retry" }))).toThrow(ChapterStorageError);
    expect(controller.networkLost(downloadRecoveryKey(poisonedJob), new Error("Offline"))).toBeNull();

    // Failing setSource() and forget() also roll back in-memory state cleanly.
    expect(() => controller.setSource({ ...existingJob, pluginId: "source-c" })).toThrow(ChapterStorageError);
    expect(controller.getSnapshot()).toMatchObject([{ key: "chapter:1", sourceId: "source-a", status: "held" }]);
    expect(() => controller.forget([downloadRecoveryKey(existingJob)])).toThrow(ChapterStorageError);
    expect(controller.getSnapshot()).toMatchObject([{ key: "chapter:1", sourceId: "source-a", status: "held" }]);
    expect(() => controller.resume()).toThrow(ChapterStorageError);
    expect(controller.getSnapshot()).toMatchObject([{ key: "chapter:1", sourceId: "source-a", status: "held" }]);

    // Once storage accepts writes (or smaller payload fits), resume() and forget() succeed cleanly without poisoned entries.
    failWrites = false;
    controller.resume();
    expect(controller.getSnapshot()).toEqual([]);
    const afterResume = JSON.parse(values.get(DOWNLOAD_RECOVERY_STORAGE_KEY)!);
    expect(afterResume.sourcePolicies).toEqual({ "source-a": 0 });

    controller.forget([downloadRecoveryKey(existingJob)], true);
    const afterForget = JSON.parse(values.get(DOWNLOAD_RECOVERY_STORAGE_KEY)!);
    expect(afterForget).toEqual({
      version: 2,
      policies: [],
      sourcePolicies: {},
      policyOverrides: [],
      episodes: [],
      siteResets: [],
    });
  });

  it("allows resume and forget to succeed under a hard quota cap after an oversized register fails", () => {
    // Allow storing source-a + one episode, but reject adding a second source with a distinct policy.
    const storage = quotaStorage(900);
    const controller = new DownloadRecoveryController(storage);
    const jobA = { id: 1, pluginId: "source-a", title: "Chapter 1" };
    controller.register([jobA], policy({ transientAction: "pause" }));
    controller.networkLost(downloadRecoveryKey(jobA), new Error("Outage"));
    expect(controller.getSnapshot()).toHaveLength(1);

    const bigBatch = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      pluginId: `source-extra-${i}-${"x".repeat(40)}`,
      title: `Chapter ${100 + i}`,
    }));
    expect(() => controller.register(bigBatch, policy({ transientAction: "retry", forbiddenAction: "resetSite" }))).toThrow(ChapterStorageError);

    // Because bigBatch was rolled back, resume() and forget() write a smaller payload that fits within the same 900-char cap.
    expect(() => controller.resume()).not.toThrow();
    expect(controller.getSnapshot()).toEqual([]);
    expect(() => controller.forget([downloadRecoveryKey(jobA)], true)).not.toThrow();
    expect(storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!.length).toBeLessThan(150);
  });

  it("prunes stale registrations, policy overrides, and idle source policies while retaining active jobs and episodes", () => {
    const storage = memoryStorage();
    const controller = new DownloadRecoveryController(storage);
    const p0 = policy({ transientAction: "pause" });
    const p1 = policy({ transientAction: "retry", maxRetries: 1 });
    controller.register([
      { id: 1, pluginId: "source-a", title: "Active 1" },
      { id: 2, pluginId: "source-a", title: "Stale 2" },
      { id: 3, pluginId: "source-stale", title: "Stale 3" },
      { id: 4, pluginId: "source-held", title: "Held 4" },
    ], p0);
    controller.register([
      { id: 5, pluginId: "source-a", title: "Stale override 5" },
      { id: 6, pluginId: "source-a", title: "Active override 6" },
    ], p1);
    controller.networkLost("chapter:4", new Error("Failed"));

    controller.prune(new Set(["chapter:1", "chapter:6"]), new Set(["source-a"]));

    // Stale jobs 2, 3, 5 are gone; active jobs 1 and 6 plus held episode 4 remain.
    expect(controller.networkLost("chapter:2", new Error("Offline"))).toBeNull();
    expect(controller.networkLost("chapter:3", new Error("Offline"))).toBeNull();
    expect(controller.networkLost("chapter:5", new Error("Offline"))).toBeNull();
    expect(controller.getSnapshot()).toMatchObject([{ key: "chapter:4", status: "held" }]);

    const persisted = JSON.parse(storage.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY)!);
    expect(Object.keys(persisted.sourcePolicies).sort()).toEqual(["source-a", "source-held"]);
    expect(persisted.policyOverrides).toEqual([{ sourceId: "source-a", policyIndex: 1, ranges: [[6, 6]] }]);

    // forgetIdle() drops idle registrations without touching held episodes.
    controller.forgetIdle(["chapter:1", "chapter:4"]);
    expect(controller.networkLost("chapter:1", new Error("Offline"))).toBeNull();
    expect(controller.getSnapshot()).toMatchObject([{ key: "chapter:4", status: "held" }]);
  });
});
