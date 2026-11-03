import { describe, expect, it, vi } from "vitest";
import type { SavedVpnProfile } from "../plugin-vpn-profiles";
import { SourceAccessRequiredError, sourceAccessScopeKey } from "../plugins/source-access";
import { PluginVpnUnavailableError } from "../plugin-vpn-traffic";
import type { ChapterDownloadJob } from "./chapter-download";
import type { SourceAccessBlock } from "./source-access-gate";
import type { TaskHandle } from "./task-types";
import { TaskUserCancelledError } from "./task-errors";
import type { VpnDownloadPlan, VpnDownloadProfileIssue, VpnDownloadProfileIssueInput, VpnDownloadRangeState, VpnDownloadWorkerRef } from "./vpn-download-types";
import { VpnDownloadCoordinator, type VpnDownloadRuntime } from "./vpn-download-coordinator";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const copy = <T>(value: T): T => structuredClone(value);
const until = (assertion: () => void) => vi.waitFor(assertion, { interval: 1, timeout: 1_000 });
const profile = (id: string): SavedVpnProfile => ({
  id, hash: `hash-${id}`, ip: `192.0.2.${id.charCodeAt(0)}`, protocol: "tcp", approvedAt: 1, approvalSequence: id.charCodeAt(0),
});

function range(id: string, profileId: string, ids: number[]): VpnDownloadRangeState {
  return {
    id, profileId, profileHash: `hash-${profileId}`, startChapterId: ids[0]!, endChapterId: ids.at(-1)!,
    chapterIds: [...ids], selectedChapterIds: [...ids], checkpoint: 0, phase: "paused", userPaused: false,
    pauseReason: null, attemptedProfileIds: [], attemptProfileId: null, generation: 0, challenge: null,
  };
}

function plan(ranges = [range("a", "a", [9, 2, 7])], id = "plan"): VpnDownloadPlan {
  return {
    id, batchId: `batch-${id}`, pluginId: "source", novelId: 10, title: "Work", mode: ranges.length > 1 ? "parallel" : "single",
    policies: { captcha: "nextProfile", cloudflare: "nextProfile" }, createdAt: 1, revision: 0, ranges,
  };
}

function jobsFor(value: VpnDownloadPlan): ChapterDownloadJob[] {
  return value.ranges.flatMap(item => item.selectedChapterIds.map(id => Object.assign({
    id, title: `Chapter ${id}`, pluginId: value.pluginId, novelId: value.novelId, chapterPath: `/chapter/${id}`,
  }, { batchId: value.batchId, vpnPlanId: value.id, vpnRangeId: item.id })));
}

interface FakeTask {
  job: ChapterDownloadJob;
  worker: VpnDownloadWorkerRef;
  result: ReturnType<typeof deferred<unknown>>;
  cleanup: ReturnType<typeof deferred>;
  cancelled: boolean;
}

class Runtime implements VpnDownloadRuntime {
  readonly stored = new Map<string, VpnDownloadPlan>();
  readonly jobs = new Map<string, ChapterDownloadJob[]>();
  readonly tasks = new Map<string, FakeTask>();
  readonly native = new Map<number, { worker: VpnDownloadWorkerRef; profile: SavedVpnProfile }>();
  readonly events: string[] = [];
  readonly notices: { planId: string; rangeId: string; reason: string; error?: unknown }[] = [];
  readonly verifications: string[] = [];
  readonly issues: VpnDownloadProfileIssue[] = [];
  profiles = [profile("a"), profile("b"), profile("c"), profile("d")];
  defaultProfiles: string[] = [];
  online = true;
  nativeGeneration = 0;
  holdCleanup = false;
  writesActive = 0;
  maxConcurrentWrites = 0;
  writeBarrier: ReturnType<typeof deferred> | null = null;
  connect: ((worker: VpnDownloadWorkerRef, value: SavedVpnProfile, signal: AbortSignal) => Promise<"connected" | "authentication-required">) | null = null;

  seed(value: VpnDownloadPlan): void {
    this.stored.set(value.id, copy(value));
    this.jobs.set(value.id, jobsFor(value));
  }

  async loadPlans(): Promise<VpnDownloadPlan[]> { return copy([...this.stored.values()]); }
  async generationFloor(): Promise<number> { return this.nativeGeneration; }
  async createPlan(value: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]): Promise<void> {
    if (this.stored.has(value.id)) throw new Error("Duplicate plan");
    this.stored.set(value.id, copy(value));
    this.jobs.set(value.id, copy([...jobs]));
  }
  async loadJobs(planId: string, rangeId: string): Promise<ChapterDownloadJob[]> {
    const value = this.stored.get(planId)!.ranges.find(item => item.id === rangeId)!;
    return copy(this.jobs.get(planId)!.filter(job => value.selectedChapterIds.includes(job.id)));
  }
  private async write<T>(operation: () => T): Promise<T> {
    this.writesActive++;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.writesActive);
    try {
      if (this.writeBarrier) await this.writeBarrier.promise;
      return operation();
    } finally { this.writesActive--; }
  }
  async updatePlan(value: VpnDownloadPlan, expectedRevision: number, options?: { restartPassRangeId: string }): Promise<VpnDownloadPlan> {
    return this.write(() => {
      const previous = this.stored.get(value.id)!;
      if (previous.revision !== expectedRevision || value.revision !== expectedRevision) throw new Error("Stale CAS");
      const assigned = value.ranges.filter(item => item.phase !== "completed" && item.phase !== "cancelled").map(item => item.profileId);
      if (new Set(assigned).size !== assigned.length) throw new Error("Unfinished profile assignments must be distinct");
      for (const item of value.ranges) {
        const old = previous.ranges.find(old => old.id === item.id)!;
        if (item.checkpoint !== old.checkpoint) throw new Error("Non-atomic checkpoint");
        if (options?.restartPassRangeId === item.id && (old.phase !== "paused" || item.phase !== "paused" || item.generation <= old.generation)) {
          throw new Error("Explicit restart requires a paused range and higher generation");
        }
        if (old.attemptedProfileIds.some((id, index) => item.attemptedProfileIds[index] !== id)) {
          if (options?.restartPassRangeId !== item.id || item.attemptedProfileIds.length ||
            JSON.stringify(old.challenge) !== JSON.stringify(item.challenge)) throw new Error("Implicit episode reset");
        }
        if (old.challenge !== null && item.challenge === null) throw new Error("Challenge cleared before settlement");
      }
      const next = copy({ ...value, revision: expectedRevision + 1 });
      this.stored.set(value.id, next);
      return copy(next);
    });
  }
  async settleChapter(planId: string, rangeId: string, chapterId: number, generation: number): Promise<VpnDownloadPlan> {
    return this.write(() => {
      const value = copy(this.stored.get(planId)!);
      const item = value.ranges.find(candidate => candidate.id === rangeId)!;
      if (item.generation !== generation || item.selectedChapterIds[item.checkpoint] !== chapterId || item.phase === "cancelled") {
        throw new Error("Invalid settlement");
      }
      item.checkpoint++;
      item.challenge = null;
      item.attemptedProfileIds = [];
      delete item.consumedReallowRevisions;
      item.attemptProfileId = null;
      if (item.checkpoint === item.selectedChapterIds.length) item.phase = "completed";
      value.revision++;
      this.stored.set(planId, value);
      this.jobs.set(planId, this.jobs.get(planId)!.filter(job => job.id !== chapterId));
      this.events.push(`settle:${rangeId}:${chapterId}`);
      return copy(value);
    });
  }
  async cancelRange(planId: string, rangeId: string): Promise<VpnDownloadPlan> {
    return this.write(() => {
      const value = copy(this.stored.get(planId)!);
      const item = value.ranges.find(candidate => candidate.id === rangeId)!;
      if (item.phase !== "completed") item.phase = "cancelled";
      this.jobs.set(planId, this.jobs.get(planId)!.filter(job => !item.selectedChapterIds.includes(job.id)));
      value.revision++;
      this.stored.set(planId, value);
      this.events.push(`cancel-range:${rangeId}`);
      return copy(value);
    });
  }
  async cancelPlan(planId: string): Promise<void> {
    await this.write(() => {
      this.stored.delete(planId);
      this.jobs.delete(planId);
      this.events.push(`cancel-plan:${planId}`);
    });
  }
  async listProfiles(): Promise<readonly SavedVpnProfile[]> { return copy(this.profiles); }
  async loadProfileIssues(batchId: string) { return copy(this.issues.filter(issue => issue.batchId === batchId)); }
  async recordProfileIssue(input: VpnDownloadProfileIssueInput): Promise<VpnDownloadProfileIssue> {
    const index = this.issues.findIndex(issue => issue.batchId === input.batchId && issue.ip === input.ip);
    const issue = { ...copy(input), recordedAt: 123, excluded: true, revision: (this.issues[index]?.revision ?? 0) + 1 };
    if (index < 0) this.issues.push(issue);
    else this.issues[index] = issue;
    return copy(issue);
  }
  async reallowProfile(batchId: string, ip: string, revision: number): Promise<VpnDownloadProfileIssue> {
    const issue = this.issues.find(issue => issue.batchId === batchId && issue.ip === ip);
    if (!issue?.excluded || issue.revision !== revision) throw new Error("Stale issue revision");
    issue.excluded = false; issue.revision++;
    return copy(issue);
  }
  reservedProfileIds(): readonly string[] { return this.defaultProfiles; }
  isOnline(): boolean { return this.online; }
  async connectWorker(worker: VpnDownloadWorkerRef, value: SavedVpnProfile, signal: AbortSignal): Promise<"connected" | "authentication-required"> {
    const stored = [...this.stored.values()].flatMap(item => item.ranges).find(item => item.id === worker.rangeId)!;
    if (stored.generation !== worker.generation || stored.attemptProfileId !== value.id || stored.profileHash !== value.hash) {
      throw new Error("Native connect preceded persisted identity/generation");
    }
    if ([...this.native.values()].some(item => item.profile.id === value.id)) throw new Error("Profile already leased");
    this.events.push(`connect:${worker.rangeId}:${value.id}:${worker.generation}`);
    const result = this.connect ? await this.connect(copy(worker), copy(value), signal) : "connected";
    if (result === "connected" && (this.native.get(worker.slot)?.worker.generation ?? 0) <= worker.generation) {
      this.native.set(worker.slot, { worker: copy(worker), profile: copy(value) });
    }
    return result;
  }
  async disconnectWorker(worker: VpnDownloadWorkerRef): Promise<void> {
    const current = this.native.get(worker.slot);
    if (current?.worker.generation === worker.generation && current.worker.rangeId === worker.rangeId) this.native.delete(worker.slot);
    this.events.push(`disconnect:${worker.rangeId}:${worker.generation}`);
  }
  async showWorker(worker: VpnDownloadWorkerRef, url: string): Promise<void> {
    if (this.native.get(worker.slot)?.worker.generation !== worker.generation) throw new Error("Wrong manual session");
    this.events.push(`show:${worker.rangeId}:${url}`);
  }
  enqueueChapter(job: ChapterDownloadJob, worker: VpnDownloadWorkerRef, planId: string): TaskHandle<unknown> {
    if (this.native.get(worker.slot)?.worker.generation !== worker.generation) throw new Error("No native route");
    if ([...this.tasks.values()].some(item => item.worker.rangeId === worker.rangeId && !item.cancelled &&
      !this.events.includes(`cleanup:${item.job.id}:${item.worker.generation}`))) throw new Error("Two chapters in one range");
    if (!this.stored.has(planId)) throw new Error("Missing plan");
    const id = `task-${this.tasks.size + 1}`;
    const item: FakeTask = { job: copy(job), worker: copy(worker), result: deferred<unknown>(), cleanup: deferred(), cancelled: false };
    this.tasks.set(id, item);
    this.events.push(`enqueue:${worker.rangeId}:${job.id}`);
    return { id, promise: item.result.promise };
  }
  cancelTask(taskId: string): void {
    const item = this.tasks.get(taskId)!;
    item.cancelled = true;
    this.events.push(`cancel:${taskId}`);
    item.result.reject(new DOMException("Task cancelled", "AbortError"));
    if (!this.holdCleanup) item.cleanup.resolve(undefined);
  }
  async waitForTask(taskId: string, worker: VpnDownloadWorkerRef): Promise<void> {
    const item = this.tasks.get(taskId)!;
    if (item.worker.generation !== worker.generation) throw new Error("Wrong executor cleanup");
    this.events.push(`waiting:${taskId}`);
    await item.cleanup.promise;
    this.events.push(`cleanup:${item.job.id}:${worker.generation}`);
  }
  requestVerification(taskId: string, worker: VpnDownloadWorkerRef): boolean {
    if (this.tasks.get(taskId)?.worker.generation !== worker.generation) throw new Error("Wrong canary");
    this.verifications.push(taskId);
    return true;
  }
  notice(value: Runtime["notices"][number]): void { this.notices.push(value); }

  task(rangeId: string, occurrence = 0): [string, FakeTask] {
    return [...this.tasks].filter(([, item]) => item.worker.rangeId === rangeId)[occurrence]!;
  }
  succeed(rangeId: string, occurrence = 0): void {
    const [, item] = this.task(rangeId, occurrence);
    item.result.resolve(undefined);
    item.cleanup.resolve(undefined);
  }
  block(rangeId: string, occurrence = 0, kind: "captcha" | "cloudflare" = "captcha", revision = 1): SourceAccessBlock {
    const [taskId, item] = this.task(rangeId, occurrence);
    const challenge = { kind, url: "https://source.test/challenge" };
    return {
      sourceId: item.job.pluginId, rangeId, workerGeneration: item.worker.generation, challenge,
      scopeKey: sourceAccessScopeKey(challenge.url, item.job.pluginId, rangeId), revision,
      originTaskId: taskId, detectedAt: 1, verificationRequested: false,
    };
  }
}

function current(coordinator: VpnDownloadCoordinator, rangeId: string): VpnDownloadRangeState {
  return coordinator.getPlans().flatMap(value => value.ranges).find(value => value.id === rangeId)!;
}

describe("VPN download coordinator", () => {
  it("persists an accepted timeout behind a sibling write even when Pause changes its epoch", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    let pauseSibling: Promise<void> | undefined;
    let pauseTimedOut: Promise<void> | undefined;
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(2));
      runtime.writeBarrier = deferred();
      pauseSibling = coordinator.pauseRange("plan", "b");
      await until(() => expect(runtime.writesActive).toBe(1));
      const [taskId, task] = runtime.task("a");
      task.result.reject(new Error("webview_extract: timeout after 35000ms")); task.cleanup.resolve(undefined);
      await until(() => expect(runtime.events).toContain(`cleanup:1:${task.worker.generation}`));
      expect(runtime.events).toContain(`waiting:${taskId}`);
      pauseTimedOut = coordinator.pauseRange("plan", "a");
      runtime.writeBarrier.resolve(undefined); runtime.writeBarrier = null;
      await Promise.all([pauseSibling, pauseTimedOut]);
      expect(runtime.stored.get("plan")!.ranges[0]).toMatchObject({
        phase: "paused", userPaused: true, pauseReason: "user-paused", checkpoint: 0, attemptedProfileIds: ["a"],
      });
      expect(runtime.tasks.size).toBe(2);
      await coordinator.resumeRange("plan", "a");
      await until(() => expect(runtime.tasks.size).toBe(3));
      expect(current(coordinator, "a").profileId).toBe("c");
    } finally {
      runtime.writeBarrier?.resolve(undefined); runtime.writeBarrier = null;
      await Promise.all([pauseSibling, pauseTimedOut]);
      await coordinator.stopAutomatic();
    }
  });

  it("does not retry a consumed reallowed profile on ordinary Resume after process restore", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const restored = new VpnDownloadCoordinator(runtime);
    const value = plan();
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(1));
      const original = runtime.task("a")[1];
      original.result.reject(new PluginVpnUnavailableError()); original.cleanup.resolve(undefined);
      await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
      const issue = runtime.issues[0]!;
      await coordinator.reallowProfile(issue.batchId, issue.ip, issue.revision);
      await until(() => expect(runtime.tasks.size).toBe(2));
      const retry = runtime.task("a", 1)[1];
      retry.result.reject(new Error("webview_extract: timeout after 35000ms")); retry.cleanup.resolve(undefined);
      await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
      await coordinator.stopAutomatic();
      await restored.restore();
      await restored.resumeRange("plan", "a");
      await until(() => expect(current(restored, "a").pauseReason === "profiles-exhausted" || runtime.tasks.size > 2).toBe(true));
      expect(runtime.tasks.size).toBe(2);
      expect(current(restored, "a")).toMatchObject({ checkpoint: 0, attemptedProfileIds: ["a"] });
      expect(runtime.issues).toMatchObject([{ excluded: false, revision: 2 }]);
    } finally { await coordinator.stopAutomatic(); await restored.stopAutomatic(); }
  });

  it("atomically exchanges released sibling assignments after simultaneous timeouts without taking a held profile", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a"), profile("b"), profile("c")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const held = range("c", "c", [3]); held.userPaused = true;
    const value = plan([range("a", "a", [1]), range("b", "b", [2]), held]);
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(2));
      for (const id of ["a", "b"]) {
        const task = runtime.task(id)[1];
        task.result.reject(new Error("webview_extract: timeout after 35000ms"));
        task.cleanup.resolve(undefined);
      }
      await until(() => expect(runtime.tasks.size).toBe(4));
      expect(current(coordinator, "a")).toMatchObject({ profileId: "b", checkpoint: 0, selectedChapterIds: [1], attemptedProfileIds: ["a", "b"] });
      expect(current(coordinator, "b")).toMatchObject({ profileId: "a", checkpoint: 0, selectedChapterIds: [2], attemptedProfileIds: ["b", "a"] });
      expect(current(coordinator, "c")).toMatchObject({ profileId: "c", userPaused: true, phase: "paused", generation: 0 });
      expect(runtime.issues).toEqual([]);
      expect(runtime.notices).toEqual([]);
      runtime.succeed("a", 1); runtime.succeed("b", 1);
      await until(() => expect([current(coordinator, "a").checkpoint, current(coordinator, "b").checkpoint]).toEqual([1, 1]));
    } finally { await coordinator.stopAutomatic(); }
  });

  it("stops a pause-policy canary after a scraper timeout instead of reconnecting the same profile", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan(); value.policies.captcha = "pause";
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(1));
      await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
      await coordinator.pauseRange("plan", "a");
      const issue = runtime.issues[0]!;
      await coordinator.reallowProfile(issue.batchId, issue.ip, issue.revision);
      await coordinator.resumeRange("plan", "a");
      await until(() => expect(runtime.tasks.size).toBe(2));
      const retry = runtime.task("a", 1)[1];
      retry.result.reject(new Error("webview_extract: timeout after 35000ms"));
      retry.cleanup.resolve(undefined);
      await until(() => expect(current(coordinator, "a").pauseReason === "download-failed" || runtime.tasks.size > 2).toBe(true));
      expect(runtime.tasks.size).toBe(2);
      expect(runtime.native.size).toBe(0);
      expect(current(coordinator, "a")).toMatchObject({
        phase: "paused", pauseReason: "download-failed", checkpoint: 0, attemptedProfileIds: ["a"],
        challenge: { kind: "captcha" },
      });
    } finally { await coordinator.stopAutomatic(); }
  });

  it.each([
    "webview_extract: timeout after 35000ms",
    "webview_fetch: timeout after 30000ms",
    "Android scraper extract timed out",
    "scraper: navigation failed (-11): net::ERR_TUNNEL_CONNECTION_FAILED at https://source.test",
  ])("retries the same unfinished chapter on another route after %s without excluding the IP", async message => {
    const runtime = new Runtime(); runtime.profiles = [profile("a"), profile("b")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(1));
      const original = runtime.task("a")[1];
      original.result.reject(new Error(message));
      await until(() => expect(runtime.events).toContain("waiting:task-1"));
      expect(runtime.tasks.size).toBe(1);
      original.cleanup.resolve(undefined);
      await until(() => expect(runtime.tasks.size).toBe(2));
      const replacement = runtime.task("a", 1)[1];
      expect(replacement.job.id).toBe(9);
      expect(replacement.worker.generation).toBeGreaterThan(original.worker.generation);
      expect(current(coordinator, "a")).toMatchObject({
        profileId: "b", checkpoint: 0, selectedChapterIds: [9, 2, 7],
      });
      expect(runtime.issues).toEqual([]);
      expect(runtime.events.indexOf(`cleanup:9:${original.worker.generation}`))
        .toBeLessThan(runtime.events.findIndex(event => event.startsWith("connect:a:b:")));
      runtime.succeed("a", 1);
      await until(() => expect(runtime.tasks.size).toBe(3));
      expect(runtime.task("a", 2)[1].job.id).toBe(2);
      expect(current(coordinator, "a")).toMatchObject({ checkpoint: 1, attemptedProfileIds: [] });
    } finally { await coordinator.stopAutomatic(); }
  });

  it("bounds repeated scraper timeouts to one profile pass without poisoning other work", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a"), profile("b")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    try {
      await coordinator.start(value, jobsFor(value));
      for (let attempt = 0; attempt < 2; attempt++) {
        await until(() => expect(runtime.tasks.size).toBe(attempt + 1));
        const task = runtime.task("a", attempt)[1];
        task.result.reject(new Error("webview_extract: timeout after 35000ms"));
        task.cleanup.resolve(undefined);
      }
      await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
      await coordinator.profilesChanged();
      expect(runtime.tasks.size).toBe(2);
      expect(runtime.issues).toEqual([]);
      expect(current(coordinator, "a")).toMatchObject({ checkpoint: 0, attemptedProfileIds: ["a", "b"] });
      const next = plan([range("next", "a", [20])], "next-work");
      await coordinator.start(next, jobsFor(next));
      await until(() => expect(runtime.tasks.size).toBe(3));
      expect(runtime.task("next")[1].job.id).toBe(20);
    } finally { await coordinator.stopAutomatic(); }
  });

  it("does not loop over a previously reallowed IP after a scraper timeout", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(1));
      const original = runtime.task("a")[1];
      original.result.reject(new PluginVpnUnavailableError()); original.cleanup.resolve(undefined);
      await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
      const issue = runtime.issues[0]!;
      await coordinator.reallowProfile(issue.batchId, issue.ip, issue.revision);
      await until(() => expect(runtime.tasks.size).toBe(2));
      const retry = runtime.task("a", 1)[1];
      retry.result.reject(new Error("webview_extract: timeout after 35000ms")); retry.cleanup.resolve(undefined);
      await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
      await coordinator.profilesChanged();
      expect(runtime.tasks.size).toBe(2);
      expect(runtime.issues).toMatchObject([{ excluded: false, revision: 2 }]);
    } finally { await coordinator.stopAutomatic(); }
  });

  it("keeps an explicit pause when a timed-out scraper is still settling", async () => {
    const runtime = new Runtime(); runtime.holdCleanup = true;
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(1));
      const task = runtime.task("a")[1];
      task.result.reject(new Error("webview_extract: timeout after 35000ms"));
      const paused = coordinator.pauseRange("plan", "a");
      task.cleanup.resolve(undefined); await paused;
      await coordinator.profilesChanged();
      expect(runtime.tasks.size).toBe(1);
      expect(current(coordinator, "a")).toMatchObject({ checkpoint: 0, userPaused: true, pauseReason: "user-paused" });
    } finally { await coordinator.stopAutomatic(); }
  });

  it("keeps a healthy connection through its frozen range and automatically assigns its released profile to a waiting work", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a")];
    const coordinator = new VpnDownloadCoordinator(runtime); coordinator.setWorkerLimit(1);
    const first = plan([range("first-range", "a", [1, 2, 3])], "first-work");
    const second = plan([range("second-range", "a", [10])], "second-work");
    try {
      await coordinator.start(first, jobsFor(first));
      await until(() => expect(runtime.tasks.size).toBe(1));
      await coordinator.start(second, jobsFor(second));
      runtime.succeed("first-range");
      await until(() => expect(runtime.tasks.size).toBe(2));
      expect([...runtime.tasks.values()].map(task => task.job.id)).toEqual([1, 2]);
      expect(coordinator.getPlans().find(plan => plan.id === first.id)?.ranges[0]?.checkpoint).toBe(1);
      runtime.succeed("first-range", 1);
      await until(() => expect(runtime.tasks.size).toBe(3));
      runtime.succeed("first-range", 2);
      await until(() => expect(runtime.tasks.size).toBe(4));
      expect([...runtime.tasks.values()].map(task => task.job.id)).toEqual([1, 2, 3, 10]);
      expect(runtime.events.filter(event => event.startsWith("connect:first-range:"))).toHaveLength(1);
    } finally { await coordinator.stopAutomatic(); }
  });

  it.each([3, 10])("dispatches %s globally bounded isolated workers for one automatically partitioned work", async limit => {
    const runtime = new Runtime();
    runtime.profiles = Array.from({ length: 10 }, (_, index) => profile(String.fromCharCode(97 + index)));
    const coordinator = new VpnDownloadCoordinator(runtime);
    coordinator.setWorkerLimit(limit);
    const value = plan(runtime.profiles.map((item, index) => range(item.id, item.id, [index + 1])));
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(limit));
      expect([...runtime.native.keys()]).toEqual(Array.from({ length: limit }, (_, index) => index));
      expect(new Set([...runtime.tasks.values()].map(task => task.worker.slot)).size).toBe(limit);
    } finally { await coordinator.stopAutomatic(); }
  });

  it.each([0, 11, 1.5, NaN])("rejects invalid global worker count %s instead of altering dispatch capacity", limit => {
    const coordinator = new VpnDownloadCoordinator(new Runtime());
    expect(() => coordinator.setWorkerLimit(limit)).toThrow(/worker|limit|count/i);
  });

  it.each([3, 10])("counts a closing worker at global limit %s until cleanup actually releases its slot", async limit => {
    const runtime = new Runtime();
    runtime.profiles = Array.from({ length: limit + 1 }, (_, index) => profile(String.fromCharCode(97 + index)));
    const coordinator = new VpnDownloadCoordinator(runtime);
    coordinator.setWorkerLimit(limit);
    const value = plan(runtime.profiles.map((item, index) => range(item.id, item.id, [index + 1])));
    const closing = deferred();
    const release = deferred();
    const disconnect = runtime.disconnectWorker.bind(runtime);
    runtime.disconnectWorker = async owner => {
      if (owner.rangeId === "a") { closing.resolve(); await release.promise; }
      await disconnect(owner);
    };
    try {
      await coordinator.start(value, jobsFor(value));
      await until(() => expect(runtime.tasks.size).toBe(limit));
      runtime.succeed("a"); await closing.promise;
      expect(runtime.tasks.size).toBe(limit);
      coordinator.setWorkerLimit(limit - 1);
      release.resolve();
      await until(() => expect(runtime.native.size).toBe(limit - 1));
      expect(runtime.tasks.size).toBe(limit);
      coordinator.setWorkerLimit(limit);
      await until(() => expect(runtime.tasks.size).toBe(limit + 1));
      expect(runtime.task(runtime.profiles.at(-1)!.id)[1].worker.slot).toBe(0);
    } finally { release.resolve(); await coordinator.stopAutomatic(); }
  });

  it("stops waiting for a busy profile when its owning sibling excludes the last healthy candidate", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a"), profile("b")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profile-in-use"));
    await coordinator.handleTaskChallenge(runtime.task("b")[0], runtime.block("b"));
    await until(() => expect(coordinator.getPlans()[0]!.ranges.map(item => item.pauseReason))
      .toEqual(["profiles-exhausted", "profiles-exhausted"]));
    expect(runtime.tasks.size).toBe(2);
    expect(runtime.native.size).toBe(0);
    expect(coordinator.getPlans()[0]!.ranges.map(item => item.checkpoint)).toEqual([0, 0]);
    await coordinator.cancelPlan(value.id);
  });
  it("retries a failed teardown without releasing its slot or permanently retaining a rejected transition", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    const close = runtime.disconnectWorker.bind(runtime); const failure = new Error("Worker close unavailable");
    runtime.disconnectWorker = async () => { throw failure; };
    await expect(coordinator.pauseRange(value.id, "a")).rejects.toBe(failure);
    expect(runtime.native.size).toBe(1);
    runtime.disconnectWorker = close;
    await coordinator.cancelPlan(value.id);
    expect(runtime.native.size).toBe(0); expect(coordinator.getPlans()).toEqual([]);
  });
  it.each(["Approval database failed", "Android IPC staging failed"])("does not exclude healthy profiles for a local connection-stage failure: %s", async message => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    runtime.connect = async () => { throw new Error(message); };
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.notices.some(notice => notice.error instanceof Error)).toBe(true));
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toHaveLength(1);
    expect(runtime.issues).toEqual([]);
    expect(current(coordinator, "a")).toMatchObject({ pauseReason: "runtime-error", attemptedProfileIds: [] });
    await coordinator.cancelPlan(value.id);
  });
  it.each([false, true])("starts above the surviving native generation floor with restored plans=%s", async populated => {
    const runtime = new Runtime(); runtime.nativeGeneration = 70;
    const value = plan(); if (populated) runtime.seed(value);
    const coordinator = new VpnDownloadCoordinator(runtime); await coordinator.restore();
    if (populated) await coordinator.resumeRange(value.id, "a");
    else await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    expect(runtime.task("a")[1].worker.generation).toBeGreaterThan(70);
    expect(runtime.issues).toEqual([]);
    await coordinator.cancelPlan(value.id);
  });
  it("allows cancellation retry after an issue write fails during pre-deletion settlement", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    const record = runtime.recordProfileIssue.bind(runtime); const write = deferred(); const entered = deferred();
    runtime.recordProfileIssue = async issue => { entered.resolve(); await write.promise; return record(issue); };
    const failure = new Error("Profile issue write failed");
    const challenge = coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    const rejectedChallenge = expect(challenge).rejects.toBe(failure); await entered.promise;
    const cancelling = coordinator.cancelPlan(value.id); const rejectedCancellation = expect(cancelling).rejects.toBe(failure);
    write.reject(failure); await Promise.all([rejectedChallenge, rejectedCancellation]);
    expect(runtime.native.size).toBe(1);
    runtime.recordProfileIssue = record;
    await coordinator.cancelPlan(value.id);
    expect(coordinator.getPlans()).toEqual([]);
    expect(runtime.native.size).toBe(0);
    expect(runtime.issues).toHaveLength(1);
  });

  it.each(["pause", "off"] as const)("does not let a pending reallow undo a newer %s whose durable write is delayed", async action => {
    const runtime = new Runtime(); runtime.profiles = [profile("a")];
    const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
    const reallow = runtime.reallowProfile.bind(runtime); const receipt = deferred(); const entered = deferred();
    runtime.reallowProfile = async (...args) => { entered.resolve(); await receipt.promise; return reallow(...args); };
    const issue = runtime.issues[0]!; const allowing = coordinator.reallowProfile(issue.batchId, issue.ip, issue.revision); await entered.promise;
    runtime.writeBarrier = deferred();
    const pausing = action === "off" ? coordinator.stopAutomatic() : coordinator.pauseRange(value.id, "a");
    receipt.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); runtime.writeBarrier.resolve(undefined);
    await Promise.all([pausing, allowing]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(current(coordinator, "a")).toMatchObject({ userPaused: action === "pause", pauseReason: action === "off" ? "automatic-off" : "user-paused" });
    expect(runtime.tasks.size).toBe(1);
    expect(runtime.issues[0]?.excluded).toBe(false);
    await coordinator.cancelPlan(value.id);
  });

  it("wakes an occupied-profile waiter when another healthy profile becomes available", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a"), profile("b")];
    const coordinator = new VpnDownloadCoordinator(runtime); const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(2));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profile-in-use"));
    runtime.profiles.push(profile("c")); await coordinator.profilesChanged();
    await until(() => expect(runtime.task("a", 1)).toBeDefined());
    expect(current(coordinator, "a")).toMatchObject({ profileId: "c", checkpoint: 0 });
    expect(runtime.task("b")[1].cancelled).toBe(false);
    await coordinator.cancelPlan(value.id);
  });

  it("does not restart an excluded pool on refresh but can resume after a new O profile is saved", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a")];
    const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
    await coordinator.profilesChanged(); expect(runtime.tasks.size).toBe(1);
    runtime.profiles.push(profile("b")); await coordinator.profilesChanged();
    await until(() => expect(runtime.task("a", 1)).toBeDefined());
    expect(current(coordinator, "a")).toMatchObject({ profileId: "b", checkpoint: 0 });
    expect(runtime.issues[0]?.excluded).toBe(true);
    await coordinator.cancelPlan(value.id);
  });

  it("waits when every healthy replacement is occupied and retries the same chapter only after actual release", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a"), profile("b")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(2));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profile-in-use"));
    expect(runtime.tasks.size).toBe(2);
    const disconnect = runtime.disconnectWorker.bind(runtime); const release = deferred();
    runtime.disconnectWorker = async worker => { if (worker.rangeId === "b") await release.promise; await disconnect(worker); };
    runtime.succeed("b"); await until(() => expect(current(coordinator, "b").phase).toBe("completed"));
    expect(runtime.tasks.size).toBe(2); release.resolve();
    await until(() => expect(runtime.task("a", 1)?.[1].job.id).toBe(1));
    expect(current(coordinator, "a")).toMatchObject({ profileId: "b", checkpoint: 0 });
    expect(runtime.notices.some(notice => notice.reason === "profiles-exhausted")).toBe(false);
    await coordinator.cancelPlan(value.id);
  });

  it("shares exclusions between plans in the same batch and reloads them before restored allocation", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime);
    const first = plan([range("a", "a", [1])], "first");
    const second = { ...plan([range("b", "b", [2])], "second"), batchId: first.batchId };
    await coordinator.start(first, jobsFor(first)); await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").profileId).toBe("b"));
    await coordinator.pauseRange(first.id, "a");
    await coordinator.start(second, jobsFor(second)); await until(() => expect(runtime.task("b")).toBeDefined());
    await coordinator.handleTaskChallenge(runtime.task("b")[0], runtime.block("b"));
    await until(() => expect(runtime.task("b", 1)).toBeDefined());
    expect(current(coordinator, "b").profileId).toBe("c");
    await coordinator.stopAutomatic();
    const restored = new VpnDownloadCoordinator(runtime); await restored.restore();
    runtime.profiles = [profile("a"), profile("b"), profile("d")];
    await restored.resumeRange(first.id, "a", { restartPass: true });
    await until(() => expect(current(restored, "a").profileId).toBe("d"));
    expect(runtime.issues.map(issue => issue.profileId)).toEqual(["a", "b"]);
    await restored.cancelPlan(first.id); await restored.cancelPlan(second.id);
  });

  it("keeps a failed lease reserved until its issue is durable during simultaneous recovery", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(2));
    const record = runtime.recordProfileIssue.bind(runtime); const write = deferred(); const entered = deferred();
    runtime.recordProfileIssue = async issue => { if (issue.profileId === "a") { entered.resolve(); await write.promise; } return record(issue); };
    const failing = coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await entered.promise;
    expect(runtime.native.get(runtime.task("a")[1].worker.slot)?.profile.id).toBe("a");
    const failB = coordinator.handleTaskChallenge(runtime.task("b")[0], runtime.block("b"));
    write.resolve(); await Promise.all([failing, failB]);
    await until(() => expect(runtime.tasks.size).toBe(4));
    expect([current(coordinator, "a").profileId, current(coordinator, "b").profileId].sort()).toEqual(["c", "d"]);
    await coordinator.cancelPlan(value.id);
  });

  it("rechecks batch exclusions after an awaited profile lookup instead of allocating a stale candidate", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(2));
    const lookup = deferred<readonly SavedVpnProfile[]>(); const entered = deferred(); let calls = 0;
    const list = runtime.listProfiles.bind(runtime);
    runtime.listProfiles = async () => { if (++calls === 1) { entered.resolve(); return lookup.promise; } return list(); };
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a")); await entered.promise;
    await coordinator.handleTaskChallenge(runtime.task("b")[0], runtime.block("b"));
    await until(() => expect(runtime.task("b", 1)).toBeDefined());
    lookup.resolve([profile("b"), profile("a"), profile("c"), profile("d")]);
    await until(() => expect(runtime.task("a", 1)).toBeDefined());
    expect(current(coordinator, "a").profileId).toBe("d");
    await coordinator.cancelPlan(value.id);
  });

  it("holds failed persistence closed and can retry that write before explicit cancellation releases the lease", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    const record = runtime.recordProfileIssue.bind(runtime); const failure = new Error("Issue database unavailable");
    runtime.recordProfileIssue = async () => { throw failure; };
    await expect(coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"))).rejects.toBe(failure);
    expect(runtime.native.size).toBe(1);
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toHaveLength(1);
    runtime.recordProfileIssue = record;
    await coordinator.cancelPlan(value.id);
    expect(runtime.native.size).toBe(0);
    expect(runtime.issues).toEqual([expect.objectContaining({ profileId: "a", cause: "captcha", excluded: true })]);
  });

  it("does not release a lost tunnel's reservation when user pause overlaps a failed issue write", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    const record = runtime.recordProfileIssue.bind(runtime); const save = deferred(); const entered = deferred();
    runtime.recordProfileIssue = async issue => { entered.resolve(); await save.promise; return record(issue); };
    const [, task] = runtime.task("a"); task.result.reject(Object.assign(new Error("Tunnel lost"), { code: "plugin-vpn-unavailable" })); task.cleanup.resolve(undefined);
    await entered.promise;
    const pausing = coordinator.pauseRange(value.id, "a");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runtime.events.filter(event => event.startsWith("disconnect:"))).toEqual([]);
    const failed = new Error("Issue write failed");
    const paused = expect(pausing).rejects.toBe(failed); save.reject(failed); await paused;
    expect(runtime.native.size).toBe(1);
    runtime.recordProfileIssue = record;
    await coordinator.cancelPlan(value.id);
    expect(runtime.native.size).toBe(0); expect(runtime.issues).toHaveLength(1);
  });

  it("does not let a delayed reallow clear a newer failure or a deliberate user pause", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    const old = runtime.issues[0]!; const reallow = runtime.reallowProfile.bind(runtime);
    const receipt = deferred(); const applied = deferred();
    runtime.reallowProfile = async (...args) => { const result = await reallow(...args); applied.resolve(); await receipt.promise; return result; };
    const allowing = coordinator.reallowProfile(old.batchId, old.ip, old.revision); await applied.promise;
    await coordinator.resumeRange(value.id, "a"); await until(() => expect(runtime.task("a", 1)).toBeDefined());
    await coordinator.handleTaskChallenge(runtime.task("a", 1)[0], runtime.block("a", 1));
    await coordinator.pauseRange(value.id, "a"); receipt.resolve(); await allowing;
    await coordinator.resumeRange(value.id, "a", { restartPass: true });
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
    expect(runtime.tasks.size).toBe(2);
    expect(runtime.issues[0]).toMatchObject({ excluded: true, revision: 3 });
    await coordinator.cancelPlan(value.id);
  });

  it("does not let a renewed file for an excluded IP evade the batch decision", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.profiles = [{ ...profile("e"), ip: profile("a").ip }, profile("b"), profile("c")];
    await coordinator.handleTaskChallenge(runtime.task("a", 1)[0], runtime.block("a", 1));
    await until(() => expect(runtime.tasks.size).toBe(3));
    expect(current(coordinator, "a").profileId).toBe("c");
    await coordinator.cancelPlan(value.id);
  });

  it("excludes a confirmed lost tunnel and retries its chapter but does not blame a parser or cancellation", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    const [, first] = runtime.task("a"); first.result.reject(Object.assign(new Error("VPN lost"), { code: "plugin-vpn-unavailable" })); first.cleanup.resolve(undefined);
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(runtime.task("a", 1)[1].job.id).toBe(9);
    expect(runtime.issues).toEqual([expect.objectContaining({ profileId: "a", cause: "tunnel-lost", excluded: true })]);
    const [, retry] = runtime.task("a", 1); retry.result.reject(new Error("Plugin parse failed")); retry.cleanup.resolve(undefined);
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("download-failed"));
    expect(runtime.issues).toHaveLength(1);
    await coordinator.cancelPlan(value.id);
  });

  it("excludes failed profiles across workers in one batch without banning them in another batch", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const shared = Object.assign(plan([range("a", "a", [1]), range("b", "b", [2])]), { batchId: "shared-batch" });
    await coordinator.start(shared, jobsFor(shared));
    await until(() => expect(runtime.tasks.size).toBe(2));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.task("a", 1)?.[1].job.id).toBe(1));
    expect(current(coordinator, "a").profileId).toBe("c");
    await coordinator.handleTaskChallenge(runtime.task("b")[0], runtime.block("b", 0, "cloudflare"));
    try {
      await until(() => expect(runtime.task("b", 1)?.[1].job.id).toBe(2));
      expect(current(coordinator, "b").profileId).toBe("d");
      expect(runtime.issues).toEqual([
        expect.objectContaining({ batchId: "shared-batch", profileId: "a", ip: profile("a").ip, cause: "captcha", rangeId: "a", excluded: true }),
        expect.objectContaining({ batchId: "shared-batch", profileId: "b", ip: profile("b").ip, cause: "cloudflare", rangeId: "b", excluded: true }),
      ]);
      expect(current(coordinator, "a").checkpoint).toBe(0);
      expect(current(coordinator, "b").checkpoint).toBe(0);
      runtime.succeed("a", 1);
      await until(() => expect(current(coordinator, "a").phase).toBe("completed"));
      const other = Object.assign(plan([range("e", "a", [3])], "other"), { batchId: "other-batch" });
      await coordinator.start(other, jobsFor(other));
      await until(() => expect(runtime.task("e")?.[1].job.id).toBe(3));
      expect(current(coordinator, "e").profileId).toBe("a");
      expect(runtime.profiles.map(value => value.id)).toEqual(["a", "b", "c", "d"]);
      await coordinator.cancelPlan(other.id);
    } finally { await coordinator.cancelPlan(shared.id); }
  });

  it("dispatches frozen selected order with one unsettled chapter per range and stable published snapshots", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    let publications = 0;
    coordinator.subscribe(() => { publications++; });
    const value = plan();
    await coordinator.start(value, jobsFor(value).reverse());
    value.ranges[0]!.selectedChapterIds.reverse();
    await until(() => expect(runtime.events.filter(event => event.startsWith("enqueue:"))).toEqual(["enqueue:a:9"]));
    const snapshot = coordinator.getPlans();
    expect(coordinator.getPlans()).toBe(snapshot);
    expect(current(coordinator, "a").checkpoint).toBe(0);
    runtime.succeed("a");
    await until(() => expect(runtime.events.filter(event => event.startsWith("enqueue:"))).toEqual(["enqueue:a:9", "enqueue:a:2"]));
    expect(coordinator.getPlans()).not.toBe(snapshot);
    expect(snapshot[0]!.ranges[0]!.checkpoint).toBe(0);
    runtime.succeed("a", 1);
    await until(() => expect(runtime.task("a", 2)[1].job.id).toBe(7));
    runtime.succeed("a", 2);
    await until(() => expect(current(coordinator, "a").phase).toBe("completed"));
    await coordinator.resumeRange("plan", "a");
    expect(runtime.tasks.size).toBe(3);
    expect(publications).toBeGreaterThan(0);
  });

  it("shares two slots globally while allowing two ranges from the same source", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const first = plan([range("a", "a", [1]), range("b", "b", [2])]);
    const second = plan([range("c", "c", [3])], "second");
    await coordinator.start(first, jobsFor(first));
    await until(() => expect(runtime.tasks.size).toBe(2));
    await coordinator.start(second, jobsFor(second));
    expect(runtime.native.size).toBe(2);
    expect(runtime.task("a")[1].worker.slot).not.toBe(runtime.task("b")[1].worker.slot);
    runtime.succeed("a");
    await until(() => expect(runtime.task("c")[1].job.id).toBe(3));
    expect(runtime.native.size).toBe(2);
    expect(runtime.task("c")[1].worker.generation).toBeGreaterThan(runtime.task("a")[1].worker.generation);
  });

  it("rechecks the global limit after persisting a worker identity before opening its tunnel", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const first = plan([range("a", "a", [1])]);
    const second = plan([range("b", "b", [2])], "second");
    await coordinator.start(first, jobsFor(first));
    await until(() => expect(runtime.tasks.size).toBe(1));
    const publication = deferred<unknown>();
    runtime.writeBarrier = publication;
    await coordinator.start(second, jobsFor(second));
    await until(() => expect(runtime.writesActive).toBe(1));
    coordinator.setWorkerLimit(1);
    runtime.writeBarrier = null;
    publication.resolve(undefined);
    try {
      await until(() => {
        expect(coordinator.getPlans().find(plan => plan.id === "second")!.ranges[0]).toMatchObject({ phase: "paused", userPaused: false });
        expect(coordinator.getPlans().find(plan => plan.id === "second")!.ranges[0]!.generation).toBeGreaterThan(0);
        expect(runtime.writesActive).toBe(0);
      });
      expect(runtime.events.filter(event => event.startsWith("connect:"))).toEqual(["connect:a:a:1"]);
      expect(runtime.tasks.size).toBe(1);
      coordinator.setWorkerLimit(2);
      await until(() => expect(runtime.tasks.size).toBe(2));
      expect(runtime.task("b")[1].job.id).toBe(2);
    } finally {
      publication.resolve(undefined);
      await coordinator.cancelPlan(first.id);
      await coordinator.cancelPlan(second.id);
    }
  });

  it("preserves an open manual verification session when the global limit is reduced", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    const [taskId, task] = runtime.task("b");
    await coordinator.handleTaskChallenge(taskId, runtime.block("b"));
    await coordinator.openVerification(value.id, "b");
    const previousEvents = [...runtime.events];
    coordinator.setWorkerLimit(1);
    await until(() => expect(runtime.events).toContain("show:b:https://source.test/challenge"));
    expect(runtime.events).toEqual(previousEvents);
    expect(runtime.native.get(task.worker.slot)?.worker).toEqual(task.worker);
    expect(current(coordinator, "b")).toMatchObject({ pauseReason: "manual-verification", challenge: { kind: "captcha" } });
    await expect(coordinator.resumeRange(value.id, "b")).rejects.toThrow(/manual/i);
    await coordinator.cancelPlan(value.id);
  });

  it("restores interrupted attempts paused without connecting or forgetting the episode", async () => {
    const runtime = new Runtime();
    const value = plan([range("a", "c", [1, 2])]);
    Object.assign(value.ranges[0]!, {
      generation: 12, checkpoint: 1, phase: "connecting", attemptProfileId: "c", attemptedProfileIds: ["a", "b"],
      challenge: { kind: "captcha", url: "https://source.test/challenge" },
    });
    runtime.seed(value);
    const coordinator = new VpnDownloadCoordinator(runtime);
    await coordinator.restore();
    expect(current(coordinator, "a")).toMatchObject({
      phase: "paused", pauseReason: "interrupted", checkpoint: 1, attemptProfileId: "c", attemptedProfileIds: ["a", "b"],
    });
    await coordinator.networkChanged(true);
    expect(runtime.native.size).toBe(0);
    expect(runtime.tasks.size).toBe(0);
    await coordinator.resumeRange("plan", "a");
    await until(() => expect(runtime.task("a")[1].job.id).toBe(2));
    expect(current(coordinator, "a").generation).toBeGreaterThan(12);
    expect(current(coordinator, "a").attemptedProfileIds).toEqual(["a", "b", "c"]);
  });

  it("keeps user pauses and run holds through restore and interrupts only the ranges a restart stopped", async () => {
    const runtime = new Runtime();
    const value = plan([range("a", "a", [1]), range("b", "b", [2]), range("c", "c", [3]), range("d", "d", [4])]);
    Object.assign(value.ranges[0]!, { phase: "running" });
    Object.assign(value.ranges[1]!, { pauseReason: "user-paused", userPaused: true });
    Object.assign(value.ranges[2]!, { pauseReason: "automatic-off" });
    Object.assign(value.ranges[3]!, { pauseReason: "profile-in-use" });
    runtime.seed(value);
    const coordinator = new VpnDownloadCoordinator(runtime);
    await coordinator.restore();
    expect(coordinator.getPlans()[0]!.ranges.map(item => [item.phase, item.pauseReason])).toEqual([
      ["paused", "interrupted"], ["paused", "user-paused"], ["paused", "automatic-off"], ["paused", "interrupted"],
    ]);
  });

  it("owns internal cancellation before rejection and waits for A's source cleanup while B progresses", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1, 2]), range("b", "b", [3, 4])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.holdCleanup = true;
    const [taskId, task] = runtime.task("a");
    const recovery = coordinator.handleTaskChallenge(taskId, runtime.block("a"));
    expect(task.cancelled).toBe(true);
    runtime.succeed("b");
    await until(() => expect(runtime.task("b", 1)[1].job.id).toBe(4));
    expect(runtime.events.filter(event => event.startsWith("connect:a:"))).toHaveLength(1);
    expect(runtime.native.get(task.worker.slot)?.profile.id).toBe("a");
    task.cleanup.resolve(undefined);
    expect(await recovery).toBe(true);
    await until(() => expect(runtime.task("a", 1)[1].job.id).toBe(1));
    const [, retry] = runtime.task("a", 1);
    expect(runtime.native.get(retry.worker.slot)?.profile.id).toBe("c");
    expect(runtime.verifications).toContain(runtime.task("a", 1)[0]);
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 0, attemptedProfileIds: ["a", "c"], userPaused: false });
    expect(runtime.events.indexOf(`cleanup:1:${task.worker.generation}`)).toBeLessThan(runtime.events.indexOf(`disconnect:a:${task.worker.generation}`));
    runtime.holdCleanup = false;
    runtime.succeed("a", 1);
    await until(() => expect(runtime.task("a", 2)[1].job.id).toBe(2));
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 1, attemptedProfileIds: [], challenge: null });
  });

  it("does not bypass batch exclusion through restartPass and resumes only after explicit profile reallow", async () => {
    const runtime = new Runtime();
    runtime.profiles = [profile("a"), profile("b")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.tasks.size).toBe(2));
    await coordinator.handleTaskChallenge(runtime.task("a", 1)[0], runtime.block("a", 1, "cloudflare", 8));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
    expect(current(coordinator, "a").attemptedProfileIds).toEqual(["a", "b"]);
    expect(runtime.native.size).toBe(0);
    expect(runtime.notices).toContainEqual({ planId: "plan", rangeId: "a", reason: "profiles-exhausted" });
    await coordinator.resumeRange("plan", "a");
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
    expect(runtime.tasks.size).toBe(2);
    await coordinator.resumeRange("plan", "a", { restartPass: true });
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
    expect(runtime.tasks.size).toBe(2);
    const issue = runtime.issues.find(issue => issue.profileId === "a")!;
    await coordinator.reallowProfile(issue.batchId, issue.ip, issue.revision);
    await until(() => expect(runtime.tasks.size).toBe(3));
    expect(current(coordinator, "a").profileId).toBe("a");
    expect(current(coordinator, "a").challenge?.kind).toBe("cloudflare");
  });

  it("consumes failed connection candidates once and persists every attempt before native connect", async () => {
    const runtime = new Runtime();
    runtime.connect = async (_worker, candidate) => {
      if (candidate.id === "a" || candidate.id === "b") throw Object.assign(new Error("Proxy refused"), { code: "plugin-vpn-unavailable" });
      return "connected";
    };
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    expect(runtime.events.filter(event => event.startsWith("connect:")).map(event => event.split(":")[2])).toEqual(["a", "b", "c"]);
    expect(current(coordinator, "a")).toMatchObject({ profileId: "c", attemptedProfileIds: ["a", "b", "c"] });
    expect(runtime.profiles.map(item => item.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("stops for authentication input instead of trying another approved profile", async () => {
    const runtime = new Runtime();
    runtime.connect = async () => "authentication-required";
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("authentication-required"));
    expect(runtime.tasks.size).toBe(0);
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toHaveLength(1);
    expect(runtime.native.size).toBe(0);
  });

  it("obeys different challenge-kind policies without resetting the episode on a new block revision", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    const originalWorker = runtime.task("a")[1].worker;
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    expect(current(coordinator, "a")).toMatchObject({ phase: "paused", pauseReason: "challenge-captcha", attemptedProfileIds: ["a"] });
    expect(runtime.native.get(originalWorker.slot)?.worker).toEqual(originalWorker);
    await coordinator.resumeRange("plan", "a");
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(runtime.task("a", 1)[1].worker).toEqual(originalWorker);
    await coordinator.handleTaskChallenge(runtime.task("a", 1)[0], runtime.block("a", 1, "cloudflare", 22));
    await until(() => expect(runtime.tasks.size).toBe(3));
    expect(current(coordinator, "a")).toMatchObject({ profileId: "b", checkpoint: 0, attemptedProfileIds: ["a", "b"] });
    expect(runtime.task("a", 2)[1].job.id).toBe(9);
  });

  it("keeps attempts through a BODY canary and a later source-owned asset challenge until full chapter settlement", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(runtime.verifications).toContain(runtime.task("a", 1)[0]);
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 0, attemptedProfileIds: ["a", "b"] });
    const assetBlock = runtime.block("a", 1, "cloudflare", 100);
    assetBlock.challenge.url = "https://source.test/asset-protection";
    await coordinator.handleTaskChallenge(runtime.task("a", 1)[0], assetBlock);
    await until(() => expect(runtime.tasks.size).toBe(3));
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 0, attemptedProfileIds: ["a", "b", "c"] });
    runtime.succeed("a", 2);
    await until(() => expect(current(coordinator, "a").checkpoint).toBe(1));
    expect(current(coordinator, "a")).toMatchObject({ attemptedProfileIds: [], attemptProfileId: null, challenge: null });
  });

  it.each([
    "HTTP 503", "Request timed out", "Storage write failed",
    "scraper: TLS certificate error 3 at https://source.test",
    "scraper: navigation failed (-11): net::ERR_CERT_AUTHORITY_INVALID at https://source.test",
  ])("does not rotate for an unstructured task failure: %s", async message => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    const [, item] = runtime.task("a");
    item.result.reject(new Error(message));
    item.cleanup.resolve(undefined);
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("download-failed"));
    expect(current(coordinator, "a").checkpoint).toBe(0);
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toHaveLength(1);
    expect(runtime.notices.at(-1)?.error).toBeInstanceOf(Error);
  });

  it.each(["task", "source", "range", "generation", "scope", "origin"])("ignores a challenge with mismatched %s ownership", async field => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    let [taskId] = runtime.task("a");
    const block = runtime.block("a");
    if (field === "task") taskId = "metadata-task";
    if (field === "source") block.sourceId = "another-source";
    if (field === "range") block.rangeId = "another-range";
    if (field === "generation") block.workerGeneration!++;
    if (field === "scope") block.scopeKey = sourceAccessScopeKey(block.challenge.url, "source", "b");
    if (field === "origin") block.originTaskId = "metadata-task";
    expect(await coordinator.handleTaskChallenge(taskId, block)).toBe(false);
    expect(current(coordinator, "a")).toMatchObject({ phase: "running", challenge: null, attemptedProfileIds: [] });
    expect(runtime.task("a")[1].cancelled).toBe(false);
  });

  it("retries the same interrupted offline candidate on return without consuming the spare pool", async () => {
    const runtime = new Runtime();
    const connection = deferred<"connected" | "authentication-required">();
    let calls = 0;
    runtime.connect = async () => ++calls === 1 ? connection.promise : "connected";
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.events.some(event => event.startsWith("connect:"))).toBe(true));
    runtime.online = false;
    await coordinator.networkChanged(false);
    expect(current(coordinator, "a")).toMatchObject({ pauseReason: "offline", attemptedProfileIds: [], attemptProfileId: "a" });
    runtime.online = true;
    await coordinator.networkChanged(true);
    await until(() => expect(runtime.tasks.size).toBe(1));
    const replacement = runtime.task("a")[1].worker;
    connection.resolve("connected");
    await until(() => expect(runtime.events.filter(event => event.startsWith("disconnect:a:"))).toHaveLength(2));
    expect(runtime.native.get(replacement.slot)?.worker).toEqual(replacement);
    expect(runtime.events.filter(event => event.startsWith("connect:")).map(event => event.split(":")[2])).toEqual(["a", "a"]);
    expect(current(coordinator, "a").attemptedProfileIds).toEqual([]);
  });

  it.each(["pause", "off"])("%s during connecting aborts intent and late completion cannot close a reused slot", async action => {
    const runtime = new Runtime();
    const connection = deferred<"connected" | "authentication-required">();
    let signal: AbortSignal | undefined;
    runtime.connect = async (worker, _profile, currentSignal) => {
      if (worker.rangeId === "a") { signal = currentSignal; return connection.promise; }
      return "connected";
    };
    const coordinator = new VpnDownloadCoordinator(runtime);
    const first = plan();
    await coordinator.start(first, jobsFor(first));
    await until(() => expect(signal).toBeDefined());
    if (action === "pause") await coordinator.pauseRange("plan", "a");
    else await coordinator.stopAutomatic();
    expect(signal!.aborted).toBe(true);
    runtime.online = false;
    await coordinator.networkChanged(false);
    runtime.online = true;
    await coordinator.networkChanged(true);
    const second = plan([range("b", "b", [20])], "second");
    await coordinator.start(second, jobsFor(second));
    await until(() => expect(runtime.tasks.size).toBe(1));
    const replacement = runtime.task("b")[1].worker;
    connection.resolve("connected");
    await until(() => expect(runtime.events.filter(event => event.startsWith("disconnect:a:"))).toHaveLength(2));
    expect(runtime.native.get(replacement.slot)?.worker).toEqual(replacement);
    expect(current(coordinator, "a")).toMatchObject({ phase: "paused", userPaused: action === "pause" });
    expect(runtime.tasks.size).toBe(1);
  });

  it("never assigns a default or sibling reserved profile during recovery", async () => {
    const runtime = new Runtime();
    runtime.defaultProfiles = ["c"];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.tasks.size).toBe(3));
    expect(current(coordinator, "a").profileId).toBe("d");
    expect(runtime.native.get(runtime.task("b")[1].worker.slot)?.profile.id).toBe("b");
    expect(runtime.defaultProfiles).toEqual(["c"]);
  });

  it("serializes exclusive profile allocation across plans then wakes the waiting owner", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const first = plan([range("a", "a", [1])]);
    const second = plan([range("b", "a", [2])], "second");
    await Promise.all([coordinator.start(first, jobsFor(first)), coordinator.start(second, jobsFor(second))]);
    await until(() => expect(runtime.tasks.size).toBe(1));
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toHaveLength(1);
    runtime.succeed("a");
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(runtime.task("b")[1].job.id).toBe(2);
    expect(runtime.native.size).toBe(1);
  });

  it.each([["removed", "c", "hash-c"], ["hash-changed", "a", "replacement-hash"]])("moves only the affected range to an idle eligible profile at the next chapter boundary when its exact profile is %s", async (change, profileId, profileHash) => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1, 2]), range("b", "b", [3, 4])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    const original = runtime.task("a")[1].worker.generation;
    if (change === "removed") runtime.profiles = runtime.profiles.filter(item => item.id !== "a");
    else runtime.profiles[0]!.hash = "replacement-hash";
    runtime.succeed("a");
    runtime.succeed("b");
    await until(() => expect(runtime.task("a", 1)[1].job.id).toBe(2));
    await until(() => expect(runtime.task("b", 1)[1].job.id).toBe(4));
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 1, profileId, profileHash, pauseReason: null, attemptedProfileIds: [] });
    expect(runtime.events).toContain(`disconnect:a:${original}`);
    expect(runtime.notices).toEqual([]);
  });

  it("reassigns a range whose assigned profile was removed before the restart instead of stopping it", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "gone", [1])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    expect(current(coordinator, "a")).toMatchObject({ profileId: "a", profileHash: "hash-a", phase: "running" });
    expect(runtime.notices).toEqual([]);
  });

  it("waits for a leased eligible profile instead of pausing when its assigned profile disappears", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a"), profile("b")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1, 2]), range("b", "b", [3])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.profiles = [profile("b")];
    runtime.succeed("a");
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profile-in-use"));
    expect(runtime.notices).toEqual([]);
    runtime.succeed("b");
    await until(() => expect(runtime.task("a", 1)[1].job.id).toBe(2));
    expect(current(coordinator, "a").profileId).toBe("b");
  });

  it("pauses once as exhausted when no eligible profile exists, then continues when a new one is saved", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1, 2])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.profiles = [];
    runtime.succeed("a");
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
    expect(runtime.notices.map(notice => notice.reason)).toEqual(["profiles-exhausted"]);
    runtime.profiles = [profile("e")];
    await coordinator.profilesChanged();
    await until(() => expect(runtime.task("a", 1)[1].job.id).toBe(2));
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 1, profileId: "e" });
  });

  it("keeps manual ownership and the challenge until explicitly resumed same-session canary settles", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    const [taskId, task] = runtime.task("a");
    const block = runtime.block("a");
    await coordinator.handleTaskChallenge(taskId, block);
    await coordinator.openVerification("plan", "a");
    expect(runtime.events).toContain("show:a:https://source.test/challenge");
    expect(await coordinator.handleTaskChallenge(taskId, { ...block, revision: 2 })).toBe(false);
    await coordinator.networkChanged(true);
    expect(runtime.tasks.size).toBe(1);
    await coordinator.finishVerification("plan", "a", { resume: false });
    expect(current(coordinator, "a").challenge).toEqual(block.challenge);
    await coordinator.openVerification("plan", "a");
    await coordinator.finishVerification("plan", "a", { resume: true });
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(runtime.task("a", 1)[1].worker).toEqual(task.worker);
    expect(current(coordinator, "a").challenge).toEqual(block.challenge);
    runtime.succeed("a", 1);
    await until(() => expect(current(coordinator, "a").challenge).toBeNull());
  });

  it("waits for source settlement before user pause disconnects and does not reset the current pass", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.holdCleanup = true;
    const [, retry] = runtime.task("a", 1);
    const paused = coordinator.pauseRange("plan", "a");
    expect(retry.cancelled).toBe(true);
    expect(runtime.native.get(retry.worker.slot)?.profile.id).toBe("b");
    retry.cleanup.resolve(undefined);
    await paused;
    expect(runtime.native.size).toBe(0);
    runtime.holdCleanup = false;
    await coordinator.resumeRange("plan", "a");
    await until(() => expect(runtime.tasks.size).toBe(3));
    expect(current(coordinator, "a")).toMatchObject({ profileId: "c", attemptedProfileIds: ["a", "b", "c"] });
  });

  it("serializes simultaneous A/B atomic settlements and subsequent CAS writes per plan", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1, 2]), range("b", "b", [3, 4])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.writeBarrier = deferred();
    runtime.succeed("a");
    runtime.succeed("b");
    await until(() => expect(runtime.writesActive).toBe(1));
    expect(runtime.maxConcurrentWrites).toBe(1);
    runtime.writeBarrier.resolve(undefined);
    runtime.writeBarrier = null;
    await until(() => expect(runtime.tasks.size).toBe(4));
    expect(coordinator.getPlans()[0]!.ranges.map(item => item.checkpoint)).toEqual([1, 1]);
    expect(runtime.stored.get("plan")!.ranges.map(item => item.checkpoint)).toEqual([1, 1]);
    expect(runtime.maxConcurrentWrites).toBe(1);
    expect(runtime.notices).toEqual([]);
  });

  it("cancels only its range after executor cleanup, then deletes its plan without touching another plan", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const first = plan([range("a", "a", [1]), range("b", "b", [2])]);
    const second = plan([range("c", "c", [3])], "second");
    await coordinator.start(first, jobsFor(first));
    await coordinator.start(second, jobsFor(second));
    await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.holdCleanup = true;
    const [, task] = runtime.task("a");
    const cancellation = coordinator.cancelRange("plan", "a");
    expect(runtime.events).not.toContain("cancel-range:a");
    task.cleanup.resolve(undefined);
    await cancellation;
    expect(current(coordinator, "a").phase).toBe("cancelled");
    await until(() => expect(runtime.task("c")[1].job.id).toBe(3));
    runtime.holdCleanup = false;
    await coordinator.cancelPlan("plan");
    expect(coordinator.getPlans().map(item => item.id)).toEqual(["second"]);
    expect(runtime.stored.has("plan")).toBe(false);
    expect(runtime.native.get(runtime.task("c")[1].worker.slot)?.profile.id).toBe("c");
  });

  it("never publishes a restored running or connecting phase before the interrupted pause is durable", async () => {
    const runtime = new Runtime();
    const value = plan();
    value.ranges[0]!.phase = "running";
    runtime.seed(value);
    const coordinator = new VpnDownloadCoordinator(runtime);
    const observed: string[] = [];
    coordinator.subscribe(() => { observed.push(current(coordinator, "a").phase); });
    await coordinator.restore();
    expect(observed).toEqual(["paused"]);
  });

  it("publishes a running phase when resuming a retained challenged session", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await coordinator.resumeRange("plan", "a");
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(current(coordinator, "a")).toMatchObject({ phase: "running", pauseReason: null });
  });

  it("does not retry the failed profile when the network interrupts challenge cleanup", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.holdCleanup = true;
    const recovery = coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").challenge?.kind).toBe("captcha"));
    runtime.online = false;
    const offline = coordinator.networkChanged(false);
    runtime.task("a")[1].cleanup.resolve(undefined);
    await Promise.all([recovery, offline]);
    runtime.holdCleanup = false;
    runtime.online = true;
    await coordinator.networkChanged(true);
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(current(coordinator, "a").profileId).toBe("b");
    expect(current(coordinator, "a").attemptedProfileIds).toEqual(["a", "b"]);
  });

  it("does not bypass a pause policy when the network changes before challenge cleanup settles", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.holdCleanup = true;
    const recovery = coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    runtime.online = false;
    const offline = coordinator.networkChanged(false);
    runtime.task("a")[1].cleanup.resolve(undefined);
    await Promise.all([recovery, offline]);
    runtime.holdCleanup = false;
    runtime.online = true;
    await coordinator.networkChanged(true);
    expect(runtime.tasks.size).toBe(1);
    expect(current(coordinator, "a").pauseReason).toBe("challenge-captcha");
  });

  it("preserves next-profile recovery when pause and resume overlap pending source cleanup", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.holdCleanup = true;
    const recovery = coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").challenge?.kind).toBe("captcha"));
    const pause = coordinator.pauseRange("plan", "a");
    const resume = coordinator.resumeRange("plan", "a");
    runtime.task("a")[1].cleanup.resolve(undefined);
    await Promise.all([recovery, pause, resume]);
    runtime.holdCleanup = false;
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(current(coordinator, "a").profileId).toBe("b");
  });

  it("waits for the network after an offline task failure instead of turning off automatic intent", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.online = false;
    runtime.task("a")[1].result.reject(new Error("Network unavailable"));
    runtime.task("a")[1].cleanup.resolve(undefined);
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("offline"));
    expect(current(coordinator, "a").attemptedProfileIds).toEqual([]);
    runtime.online = true;
    await coordinator.networkChanged(true);
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(runtime.task("a", 1)[1].job.id).toBe(9);
    expect(current(coordinator, "a").profileId).toBe("a");
  });

  it("separates an externally user-cancelled task from transport failure and internal recovery cancellation", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.task("a")[1].result.reject(new TaskUserCancelledError());
    runtime.task("a")[1].cleanup.resolve(undefined);
    await until(() => expect(current(coordinator, "a").userPaused).toBe(true));
    expect(current(coordinator, "a").pauseReason).toBe("user-paused");
    await coordinator.networkChanged(true);
    expect(runtime.tasks.size).toBe(1);
  });

  it("does not evict a paused challenge session to make space for a third range", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const first = plan([range("a", "a", [1]), range("b", "b", [2])]);
    first.policies.captcha = "pause";
    const second = plan([range("c", "c", [3])], "second");
    await coordinator.start(first, jobsFor(first));
    await until(() => expect(runtime.tasks.size).toBe(2));
    const [, original] = runtime.task("a");
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await coordinator.start(second, jobsFor(second));
    expect(runtime.tasks.size).toBe(2);
    expect(runtime.native.get(original.worker.slot)?.worker).toEqual(original.worker);
    runtime.succeed("b");
    await until(() => expect(runtime.task("c")[1].job.id).toBe(3));
    expect(runtime.native.get(original.worker.slot)?.worker).toEqual(original.worker);
  });

  it("checks the retained hash after durable resume writes and dispatches on a replacement instead", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    const update = runtime.updatePlan.bind(runtime);
    runtime.updatePlan = async (next, revision) => {
      const stored = await update(next, revision);
      if (next.ranges[0]!.phase === "running") runtime.profiles = runtime.profiles.filter(item => item.id !== "a");
      return stored;
    };
    await coordinator.resumeRange("plan", "a");
    await until(() => expect(runtime.tasks.size).toBe(2));
    const [taskId, replacement] = runtime.task("a", 1);
    expect(runtime.native.get(replacement.worker.slot)?.profile.id).toBe("b");
    expect(runtime.verifications).toEqual([taskId]);
    expect(current(coordinator, "a")).toMatchObject({ profileId: "b", challenge: { kind: "captcha" } });
  });

  it("cancels a refused scheduler canary without dispatching a replacement or clearing its challenge", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.requestVerification = () => false;
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("verification-unavailable"));
    expect(runtime.task("a", 1)[1].cancelled).toBe(true);
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 0, attemptedProfileIds: ["a", "b"], challenge: { kind: "captcha" } });
    expect(runtime.tasks.size).toBe(2);
  });

  it("pauses on atomic settlement failure without resetting the episode or rotating the route", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.settleChapter = async () => { throw new Error("SQLite transaction rolled back"); };
    runtime.succeed("a", 1);
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("runtime-error"));
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 0, attemptedProfileIds: ["a", "b"], challenge: { kind: "captcha" } });
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toHaveLength(2);
    expect(runtime.stored.get("plan")!.ranges[0]!.checkpoint).toBe(0);
  });

  it("does not infer rotation from a rejected source-access error without an enrolled structured block", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.task("a")[1].result.reject(new SourceAccessRequiredError("Blocked", { kind: "captcha", url: "https://source.test/challenge" }));
    runtime.task("a")[1].cleanup.resolve(undefined);
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("download-failed"));
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toHaveLength(1);
    expect(current(coordinator, "a").challenge).toBeNull();
  });

  it("settles a live canary's source requests before foregrounding the same manual worker", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.holdCleanup = true;
    const [taskId, canary] = runtime.task("a", 1);
    const opening = coordinator.openVerification("plan", "a");
    expect(canary.cancelled).toBe(true);
    expect(runtime.events.some(event => event.startsWith("show:"))).toBe(false);
    expect(await coordinator.handleTaskChallenge(taskId, runtime.block("a", 1))).toBe(false);
    canary.cleanup.resolve(undefined);
    expect(await opening).toBe(true);
    expect(runtime.native.get(canary.worker.slot)?.worker).toEqual(canary.worker);
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toHaveLength(2);
  });

  it("starts offline plans held with a durable reason and resumes only after a network return", async () => {
    const runtime = new Runtime();
    runtime.online = false;
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    expect(current(coordinator, "a")).toMatchObject({ phase: "paused", pauseReason: "offline", userPaused: false });
    expect(runtime.stored.get("plan")!.ranges[0]!.pauseReason).toBe("offline");
    expect(runtime.tasks.size).toBe(0);
    runtime.online = true;
    await coordinator.networkChanged(true);
    await until(() => expect(runtime.task("a")[1].job.id).toBe(9));
  });

  it.each(["pause", "off"])("persists an accepted challenge even when %s supersedes its queued recovery write immediately", async action => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    const recovery = coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    const stopping = action === "pause" ? coordinator.pauseRange("plan", "a") : coordinator.stopAutomatic();
    await Promise.all([recovery, stopping]);
    expect(current(coordinator, "a")).toMatchObject({
      userPaused: action === "pause", attemptedProfileIds: ["a"], challenge: { kind: "captcha" },
    });
    await coordinator.resumeRange("plan", "a");
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(current(coordinator, "a")).toMatchObject({ profileId: "b", attemptedProfileIds: ["a", "b"] });
  });

  it("does not advance or clear the canary episode until successful task executor settlement", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan();
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(runtime.tasks.size).toBe(2));
    const [taskId, canary] = runtime.task("a", 1);
    canary.result.resolve(undefined);
    await until(() => expect(runtime.events).toContain(`waiting:${taskId}`));
    expect(current(coordinator, "a")).toMatchObject({ checkpoint: 0, attemptedProfileIds: ["a", "b"], challenge: { kind: "captcha" } });
    expect(runtime.tasks.size).toBe(2);
    canary.cleanup.resolve(undefined);
    await until(() => expect(current(coordinator, "a").checkpoint).toBe(1));
    expect(current(coordinator, "a")).toMatchObject({ attemptedProfileIds: [], challenge: null });
  });

  it.each(["completed", "cancelled"] as const)("reuses a %s sibling's released profile while protecting a live paused sibling", async phase => {
    const runtime = new Runtime();
    runtime.profiles = [profile("a"), profile("c"), profile("b")];
    const coordinator = new VpnDownloadCoordinator(runtime);
    const live = range("c", "c", [3]);
    live.userPaused = true;
    const value = plan([range("a", "a", [1]), range("b", "b", [2]), live]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    if (phase === "completed") {
      runtime.succeed("b");
      await until(() => expect(current(coordinator, "b").phase).toBe("completed"));
      await until(() => expect(runtime.native.size).toBe(1));
    } else await coordinator.cancelRange("plan", "b");
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a")).toMatchObject({ profileId: "b", phase: "running" }));
    expect(runtime.task("a", 1)[1].job.id).toBe(1);
    expect(current(coordinator, "a")).toMatchObject({ profileId: "b", attemptedProfileIds: ["a", "b"] });
    expect(current(coordinator, "b")).toMatchObject({ profileId: "b", phase });
    expect(current(coordinator, "c")).toMatchObject({ profileId: "c", phase: "paused", userPaused: true });
    expect(runtime.events.some(event => event.startsWith("connect:c:"))).toBe(false);
    expect(runtime.native.get(runtime.task("a", 1)[1].worker.slot)?.profile.id).toBe("b");
  });

  it("persists A's higher restart generation without invalidating B's pending native ref in the same plan", async () => {
    const runtime = new Runtime();
    const pending = deferred<"connected" | "authentication-required">();
    let pendingWorker: VpnDownloadWorkerRef | undefined;
    let aConnections = 0;
    runtime.connect = async worker => {
      if (worker.rangeId === "b") { pendingWorker = worker; return pending.promise; }
      return ++aConnections === 1 ? "authentication-required" : "connected";
    };
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("authentication-required"));
    await until(() => expect(pendingWorker).toBeDefined());
    const oldGeneration = current(coordinator, "a").generation;
    await coordinator.resumeRange("plan", "a", { restartPass: true });
    await until(() => expect(runtime.task("a")[1].job.id).toBe(1));
    const restarted = runtime.task("a")[1].worker;
    expect(restarted.generation).toBeGreaterThan(oldGeneration);
    expect(restarted.generation).toBeGreaterThan(pendingWorker!.generation);
    expect(current(coordinator, "b")).toMatchObject({ phase: "connecting", generation: pendingWorker!.generation, attemptProfileId: "b" });
    pending.resolve("connected");
    await until(() => expect(runtime.task("b")[1].worker).toEqual(pendingWorker));
    expect(current(coordinator, "b").generation).toBe(pendingWorker!.generation);
    expect(current(coordinator, "a").generation).toBe(restarted.generation);
    expect(runtime.maxConcurrentWrites).toBe(1);
    expect(runtime.notices.filter(notice => notice.reason !== "authentication-required")).toEqual([]);
  });

  it("releases a retained challenged session before persisting and connecting its explicit new pass", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    const oldWorker = runtime.task("a")[1].worker;
    const sibling = runtime.task("b")[1].worker;
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    const issue = runtime.issues[0]!; await coordinator.reallowProfile(issue.batchId, issue.ip, issue.revision);
    await coordinator.resumeRange("plan", "a", { restartPass: true });
    await until(() => expect(runtime.task("a", 1)[1].job.id).toBe(1));
    const replacement = runtime.task("a", 1)[1].worker;
    expect(replacement.generation).toBeGreaterThan(oldWorker.generation);
    expect(current(coordinator, "a").generation).toBe(replacement.generation);
    expect(current(coordinator, "a").challenge?.kind).toBe("captcha");
    expect(runtime.events.indexOf(`disconnect:a:${oldWorker.generation}`)).toBeLessThan(runtime.events.indexOf(`connect:a:a:${replacement.generation}`));
    expect(runtime.native.get(sibling.slot)?.worker).toEqual(sibling);
    runtime.succeed("a", 1);
    await until(() => expect(current(coordinator, "a").phase).toBe("completed"));
    expect(runtime.notices.filter(notice => notice.reason === "runtime-error")).toEqual([]);
  });

  it("rejects resume after plan cancellation has quiesced only one sibling", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(2));
    runtime.holdCleanup = true;
    const cancelling = coordinator.cancelPlan("plan");
    runtime.task("a")[1].cleanup.resolve(undefined);
    await until(() => expect(runtime.events.some(event => event.startsWith("disconnect:a:"))).toBe(true));
    await expect(coordinator.resumeRange("plan", "a")).rejects.toThrow(/cancel/i);
    runtime.task("b")[1].cleanup.resolve(undefined); await cancelling;
    expect(runtime.native.size).toBe(0); expect(runtime.tasks.size).toBe(2);
    expect(coordinator.getPlans()).toEqual([]);
  });

  it("retries failed plan deletion while keeping the cancellation fence during the retry", async () => {
    const runtime = new Runtime();
    const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan([range("a", "a", [1]), range("b", "b", [2])]);
    await coordinator.start(value, jobsFor(value));
    await until(() => expect(runtime.tasks.size).toBe(2));
    const remove = runtime.cancelPlan.bind(runtime);
    const retryDeletion = deferred();
    const storageError = new Error("Database deletion failed");
    let attempts = 0;
    runtime.cancelPlan = async id => {
      if (++attempts === 1) throw storageError;
      await retryDeletion.promise;
      await remove(id);
    };

    await expect(coordinator.cancelPlan("plan")).rejects.toBe(storageError);
    expect(attempts).toBe(1);
    expect(runtime.native.size).toBe(0);
    expect(runtime.stored.has("plan")).toBe(true);
    expect(coordinator.getPlans()[0]!.ranges.every(range => range.phase === "paused" && range.userPaused)).toBe(true);

    const retry = coordinator.cancelPlan("plan");
    await until(() => expect(attempts).toBe(2));
    await expect(coordinator.resumeRange("plan", "a")).rejects.toThrow(/cancel/i);
    retryDeletion.resolve();
    await retry;

    expect(runtime.stored.has("plan")).toBe(false);
    expect(runtime.jobs.has("plan")).toBe(false);
    expect(coordinator.getPlans()).toEqual([]);
    expect(runtime.native.size).toBe(0);
    expect(runtime.tasks.size).toBe(2);
  });

  it("holds a pending plan creation paused when explicit Off arrives before publication", async () => {
    const runtime = new Runtime(); const publication = deferred();
    const create = runtime.createPlan.bind(runtime);
    runtime.createPlan = async (plan, jobs) => { await publication.promise; await create(plan, jobs); };
    const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    const start = coordinator.start(value, jobsFor(value));
    await coordinator.stopAutomatic(); publication.resolve(); await start;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runtime.events.filter(event => event.startsWith("connect:"))).toEqual([]);
    expect(current(coordinator, "a")).toMatchObject({ phase: "paused", pauseReason: "automatic-off", userPaused: false });
    expect(runtime.stored.get("plan")!.ranges[0]).toMatchObject({ pauseReason: "automatic-off" });
  });

  it("stops a pause-policy same-profile resume after one connection failure", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime);
    const value = plan(); value.policies.captcha = "pause";
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await coordinator.pauseRange("plan", "a");
    const issue = runtime.issues[0]!; await coordinator.reallowProfile(issue.batchId, issue.ip, issue.revision);
    let attempts = 0;
    runtime.connect = async () => { if (++attempts < 3) throw Object.assign(new Error("Transport failed"), { code: "plugin-vpn-unavailable" }); return "authentication-required"; };
    await coordinator.resumeRange("plan", "a");
    await until(() => expect(runtime.notices.some(notice => notice.error instanceof Error)).toBe(true));
    expect(attempts).toBe(1);
    expect(current(coordinator, "a")).toMatchObject({ phase: "paused", pauseReason: "download-failed", attemptedProfileIds: ["a"] });
  });

  it("finishes accepted replacement cleanup before ordinary Resume can dispatch", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    runtime.holdCleanup = true;
    const recovery = coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").challenge).not.toBeNull());
    const resume = coordinator.resumeRange("plan", "a");
    runtime.task("a")[1].cleanup.resolve(undefined); await Promise.all([recovery, resume]);
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(runtime.task("a", 1)[1].worker.generation).toBeGreaterThan(runtime.task("a")[1].worker.generation);
    expect(current(coordinator, "a").profileId).toBe("b");
  });

  it("keeps explicit restart gated while its durable reset is pending", async () => {
    const runtime = new Runtime(); runtime.profiles = [profile("a")];
    const coordinator = new VpnDownloadCoordinator(runtime); const value = plan();
    await coordinator.start(value, jobsFor(value)); await until(() => expect(runtime.tasks.size).toBe(1));
    await coordinator.handleTaskChallenge(runtime.task("a")[0], runtime.block("a"));
    await until(() => expect(current(coordinator, "a").pauseReason).toBe("profiles-exhausted"));
    await coordinator.pauseRange("plan", "a");
    const issue = runtime.issues[0]!; await coordinator.reallowProfile(issue.batchId, issue.ip, issue.revision);
    const update = runtime.updatePlan.bind(runtime); const reset = deferred(); const entered = deferred();
    runtime.updatePlan = async (plan, revision, options) => { if (options) { entered.resolve(); await reset.promise; } return update(plan, revision, options); };
    const restart = coordinator.resumeRange("plan", "a", { restartPass: true }); await entered.promise;
    await coordinator.networkChanged(true);
    await new Promise(resolve => setTimeout(resolve, 10)); reset.resolve(); await restart;
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(current(coordinator, "a")).toMatchObject({ phase: "running", pauseReason: null });
  });

  it("wakes a profile waiter if release occurs while its wait-state write is pending", async () => {
    const runtime = new Runtime(); const coordinator = new VpnDownloadCoordinator(runtime);
    const a = plan([range("a", "a", [1])], "first");
    await coordinator.start(a, jobsFor(a)); await until(() => expect(runtime.tasks.size).toBe(1));
    const disconnect = runtime.disconnectWorker.bind(runtime); const held = deferred(); const closing = deferred();
    runtime.disconnectWorker = async ref => { if (ref.rangeId === "a") { closing.resolve(); await held.promise; } await disconnect(ref); };
    runtime.succeed("a"); await closing.promise;
    const update = runtime.updatePlan.bind(runtime); const waitWrite = deferred(); const waiting = deferred();
    runtime.updatePlan = async (plan, revision, options) => { if (plan.ranges[0]?.pauseReason === "profile-in-use") { waiting.resolve(); await waitWrite.promise; } return update(plan, revision, options); };
    const b = plan([range("b", "a", [2])], "second"); await coordinator.start(b, jobsFor(b)); await waiting.promise;
    held.resolve(); await until(() => expect(runtime.native.size).toBe(0));
    waitWrite.resolve();
    await until(() => expect(runtime.tasks.size).toBe(2));
    expect(runtime.task("b")[1].job.id).toBe(2);
  });
});
