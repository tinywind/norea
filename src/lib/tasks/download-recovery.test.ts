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
    const controller = new DownloadRecoveryController(memoryStorage());
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
