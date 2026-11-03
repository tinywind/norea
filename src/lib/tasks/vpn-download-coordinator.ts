import { isPluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { sourceAccessScopeKey, type SourceAccessChallenge } from "../plugins/source-access";
import type { ChapterDownloadJob } from "./chapter-download";
import type { SourceAccessBlock } from "./source-access-gate";
import { isTaskUserCancelledError } from "./task-errors";
import type { TaskHandle } from "./task-types";
import type {
  VpnDownloadPlan, VpnDownloadProfile, VpnDownloadProfileIssue, VpnDownloadProfileIssueCause,
  VpnDownloadProfileIssueInput, VpnDownloadRangeState, VpnDownloadWorkerRef,
} from "./vpn-download-types";
import { isVpnDownloadWorkerSlot, MAX_VPN_DOWNLOAD_WORKERS } from "./vpn-download-types";

export interface VpnDownloadNotice {
  planId: string;
  rangeId: string;
  reason: string;
  error?: unknown;
}

/** All worker operations are generation-scoped; task promises include body and source-owned assets. */
export interface VpnDownloadRuntime {
  generationFloor(): Promise<number>;
  loadPlans(): Promise<VpnDownloadPlan[]>;
  createPlan(plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]): Promise<void>;
  loadJobs(planId: string, rangeId: string): Promise<ChapterDownloadJob[]>;
  updatePlan(plan: VpnDownloadPlan, expectedRevision: number, options?: { restartPassRangeId: string }): Promise<VpnDownloadPlan>;
  settleChapter(planId: string, rangeId: string, chapterId: number, expectedGeneration: number): Promise<VpnDownloadPlan>;
  cancelRange(planId: string, rangeId: string): Promise<VpnDownloadPlan>;
  cancelPlan(planId: string): Promise<void>;
  listProfiles(): Promise<readonly VpnDownloadProfile[]>;
  loadProfileIssues(batchId: string): Promise<VpnDownloadProfileIssue[]>;
  recordProfileIssue(input: VpnDownloadProfileIssueInput): Promise<VpnDownloadProfileIssue>;
  reallowProfile(batchId: string, ip: string, expectedRevision: number): Promise<VpnDownloadProfileIssue>;
  reservedProfileIds(): readonly string[];
  connectWorker(worker: VpnDownloadWorkerRef, profile: VpnDownloadProfile, signal: AbortSignal): Promise<"connected" | "authentication-required">;
  disconnectWorker(worker: VpnDownloadWorkerRef): Promise<void>;
  showWorker(worker: VpnDownloadWorkerRef, url: string): Promise<void>;
  enqueueChapter(job: ChapterDownloadJob, worker: VpnDownloadWorkerRef, planId: string): TaskHandle<unknown>;
  cancelTask(taskId: string): void | Promise<void>;
  waitForTask(taskId: string, worker: VpnDownloadWorkerRef): Promise<void>;
  requestVerification(taskId: string, worker: VpnDownloadWorkerRef, challenge: SourceAccessChallenge): boolean;
  isOnline(): boolean;
  notice(notice: VpnDownloadNotice): void;
}

interface WorkerLease {
  owner: RangeRuntime;
  ref: VpnDownloadWorkerRef;
  profile: VpnDownloadProfile;
  abort: AbortController;
  connected: boolean;
  closing?: Promise<void>;
  cleanupError?: unknown;
}

type ChapterResult = { ok: true } | { ok: false; error: unknown };

interface EnrolledChapter {
  handle: TaskHandle<unknown>;
  lease: WorkerLease;
  epoch: number;
  owned: boolean;
  settled: Promise<void>;
  cancellation?: Promise<void>;
}

interface RangeRuntime {
  planId: string;
  rangeId: string;
  epoch: number;
  intent: boolean;
  userHeld: boolean;
  manual: boolean;
  networkHeld: boolean;
  jobs: Map<number, ChapterDownloadJob> | null;
  worker?: WorkerLease;
  task?: EnrolledChapter;
  run?: { epoch: number };
  transition: Promise<void>;
  /** Leased candidates this range waits for. */
  waitingProfiles?: string[];
  /** Holds one dispatch budget unit between scheduling and slot allocation. */
  dispatching?: boolean;
}

const clone = <T>(value: T): T => structuredClone(value);
const terminal = (range: VpnDownloadRangeState): boolean => range.phase === "completed" || range.phase === "cancelled";
const key = (planId: string, rangeId: string): string => JSON.stringify([planId, rangeId]);
const addAttempt = (range: VpnDownloadRangeState, profileId: string): void => {
  if (!range.attemptedProfileIds.includes(profileId)) range.attemptedProfileIds.push(profileId);
};
const consumeReallow = (range: VpnDownloadRangeState, profileId: string, issue: VpnDownloadProfileIssue | undefined): void => {
  if (issue?.excluded !== false) return;
  range.consumedReallowRevisions = {
    ...range.consumedReallowRevisions,
    [profileId]: Math.max(range.consumedReallowRevisions?.[profileId] ?? 0, issue.revision),
  };
};
const isRetryableScraperFailure = (error: unknown): boolean => error instanceof Error &&
  /^(?:webview_(?:fetch|extract): (?:timeout|timed out)\b|Android scraper (?:fetch|extract) timed out$|scraper: navigation failed \(-11\): net::ERR_TUNNEL_CONNECTION_FAILED at https?:\/\/)/i.test(error.message);

function freezePlan(input: VpnDownloadPlan): VpnDownloadPlan {
  const plan = clone(input);
  for (const range of plan.ranges) {
    Object.freeze(range.chapterIds);
    Object.freeze(range.selectedChapterIds);
    Object.freeze(range.attemptedProfileIds);
    if (range.consumedReallowRevisions) Object.freeze(range.consumedReallowRevisions);
    if (range.challenge) Object.freeze(range.challenge);
    Object.freeze(range);
  }
  Object.freeze(plan.ranges);
  Object.freeze(plan.policies);
  return Object.freeze(plan);
}

export class VpnDownloadCoordinator {
  private readonly plans = new Map<string, VpnDownloadPlan>();
  private readonly ranges = new Map<string, RangeRuntime>();
  private readonly enrolled = new Map<string, RangeRuntime>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly cancellingPlans = new Set<string>();
  private readonly pausedWorks = new Set<string>();
  private readonly profileIssues = new Map<string, Map<string, VpnDownloadProfileIssue>>();
  private readonly issueLoads = new Map<string, Promise<void>>();
  private readonly pendingExclusions = new Map<string, VpnDownloadProfileIssueInput>();
  private readonly issueWrites = new Map<string, Promise<void>>();
  private readonly slots: (WorkerLease | undefined)[] = Array.from({ length: MAX_VPN_DOWNLOAD_WORKERS });
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly VpnDownloadPlan[] = Object.freeze([]);
  private generation = 0;
  private generationSeed?: Promise<void>;
  private online: boolean;
  private scheduled = false;
  private restoring = false;
  private automaticStopEpoch = 0;
  private workerLimit = 2;
  private readonly connectedProfiles = new Map<string, number>();
  private successSequence = 0;
  private readonly failedProfiles = new Map<string, number>();

  constructor(private readonly runtime: VpnDownloadRuntime) {
    this.online = runtime.isOnline();
  }

  getPlans = (): readonly VpnDownloadPlan[] => this.snapshot;

  setWorkerLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VPN_DOWNLOAD_WORKERS) {
      throw new Error("VPN worker count must be an integer from 1 through 10.");
    }
    if (this.workerLimit === limit) return;
    this.workerLimit = limit;
    this.schedule();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async restore(): Promise<void> {
    if (this.restoring || this.ranges.size) throw new Error("Restore VPN plans before starting workers.");
    this.restoring = true;
    try {
      const plans = await this.runtime.loadPlans();
      await this.seedGeneration();
      await Promise.all(plans.map(plan => this.loadProfileIssues(plan.batchId)));
      for (const plan of plans) {
        for (const range of plan.ranges) this.generation = Math.max(this.generation, range.generation);
      }
      await Promise.all(plans.map(plan => this.serialize(plan.id, async () => {
        const next = clone(plan);
        let changed = false;
        for (const range of next.ranges) {
          if (terminal(range)) continue;
          if (range.userPaused && range.pauseReason === "work-paused") {
            this.pausedWorks.add(JSON.stringify([plan.pluginId, plan.novelId]));
            continue;
          }
          // User pauses and run holds (run Pause, VPN off, device-restore suspension) survive the restart unchanged.
          if (range.phase === "paused" && (range.userPaused || range.pauseReason === "automatic-off")) continue;
          changed ||= range.phase !== "paused" || range.pauseReason !== "interrupted";
          range.phase = "paused";
          range.pauseReason = "interrupted";
        }
        this.register(changed ? await this.runtime.updatePlan(next, next.revision) : next, false);
      })));
    } finally { this.restoring = false; }
  }

  async start(input: VpnDownloadPlan, inputJobs: readonly ChapterDownloadJob[]): Promise<void> {
    if (this.restoring) throw new Error("VPN plans are being restored.");
    const plan = clone(input);
    const stopEpoch = this.automaticStopEpoch;
    const jobs = clone([...inputJobs]);
    if (!this.online) {
      for (const range of plan.ranges) {
        if (terminal(range) || range.userPaused) continue;
        range.phase = "paused";
        range.pauseReason = "offline";
      }
    }
    await this.serialize(plan.id, async () => {
      if (this.plans.has(plan.id)) throw new Error("VPN download plan is already enrolled.");
      await this.seedGeneration();
      await this.loadProfileIssues(plan.batchId);
      await this.runtime.createPlan(plan, jobs);
      const workPaused = this.pausedWorks.has(JSON.stringify([plan.pluginId, plan.novelId]));
      const automatic = this.automaticStopEpoch === stopEpoch && !workPaused;
      if (!automatic) {
        for (const range of plan.ranges) {
          if (terminal(range)) continue;
          range.phase = "paused";
          range.pauseReason = workPaused ? "work-paused" : "automatic-off";
          if (workPaused) range.userPaused = true;
        }
      }
      this.register(automatic ? plan : await this.runtime.updatePlan(plan, plan.revision), automatic, jobs);
    });
    this.schedule();
  }

  async resumeRange(planId: string, rangeId: string, options: { restartPass?: boolean } = {}): Promise<void> {
    if (this.cancellingPlans.has(planId)) throw new Error("VPN download plan is being cancelled.");
    const range = this.requireRange(planId, rangeId);
    const plan = this.plans.get(planId)!;
    if (this.pausedWorks.has(JSON.stringify([plan.pluginId, plan.novelId]))) throw new Error("Resume the paused work before resuming its ranges.");
    const state = this.state(range);
    if (terminal(state)) return;
    if (range.manual) throw new Error("Finish manual VPN verification before resuming.");
    if (range.intent && range.run?.epoch === range.epoch && !range.networkHeld) return;
    const requestedEpoch = range.epoch;
    await this.settleTransition(range);
    if (!this.isEpoch(range, requestedEpoch) || this.cancellingPlans.has(planId)) return;
    if (options.restartPass) {
      const stopped = this.halt(range, state.pauseReason ?? "user-paused", state.userPaused, true, false);
      const stoppedEpoch = range.epoch;
      await stopped;
      if (!this.isEpoch(range, stoppedEpoch)) return;
    }
    range.intent = false;
    range.userHeld = false;
    range.networkHeld = !this.online;
    range.waitingProfiles = undefined;
    const epoch = ++range.epoch;
    await this.updateRange(range, next => {
      next.userPaused = false;
      next.phase = "paused";
      next.pauseReason = this.online ? null : "offline";
      if (options.restartPass) {
        next.generation = ++this.generation;
        next.attemptedProfileIds = [];
        delete next.consumedReallowRevisions;
        next.attemptProfileId = null;
      }
    }, epoch, options.restartPass);
    if (!this.isEpoch(range, epoch)) return;
    range.intent = true;
    range.networkHeld = !this.online;
    this.schedule();
  }

  pauseRange(planId: string, rangeId: string): Promise<void> {
    const range = this.requireRange(planId, rangeId);
    range.manual = false;
    return this.halt(range, "user-paused", true, true, false);
  }

  pauseWork(pluginId: string, novelId: number): Promise<void> {
    this.pausedWorks.add(JSON.stringify([pluginId, novelId]));
    const pending: Promise<void>[] = [];
    for (const plan of this.plans.values()) {
      if (plan.pluginId !== pluginId || plan.novelId !== novelId) continue;
      for (const state of plan.ranges) {
        if (terminal(state) || state.userPaused && state.pauseReason !== "work-paused") continue;
        const range = this.requireRange(plan.id, state.id);
        range.manual = false;
        pending.push(this.halt(range, "work-paused", true, true, false));
      }
    }
    return Promise.all(pending).then(() => undefined);
  }

  async resumeWork(pluginId: string, novelId: number, canContinue: () => boolean): Promise<void> {
    this.pausedWorks.delete(JSON.stringify([pluginId, novelId]));
    for (const plan of this.getPlans()) {
      if (plan.pluginId !== pluginId || plan.novelId !== novelId) continue;
      for (const range of plan.ranges) {
        if (!canContinue()) return;
        if (range.phase === "paused" && (range.pauseReason === "work-paused" || !range.userPaused && range.pauseReason !== "profiles-exhausted")) {
          await this.resumeRange(plan.id, range.id);
        }
      }
    }
  }

  clearWorkHolds(): void { this.pausedWorks.clear(); }
  clearWorkHold(pluginId: string, novelId: number): void { this.pausedWorks.delete(JSON.stringify([pluginId, novelId])); }

  async reallowProfile(batchId: string, ip: string, expectedRevision: number): Promise<void> {
    const epochs = new Map([...this.ranges.values()].map(range => [range, range.epoch]));
    await this.loadProfileIssues(batchId);
    if (this.pendingExclusions.has(key(batchId, ip))) throw new Error("A new VPN profile failure is still being recorded.");
    const issue = await this.runtime.reallowProfile(batchId, ip, expectedRevision);
    const issues = this.profileIssues.get(batchId)!;
    if ((issues.get(ip)?.revision ?? 0) < issue.revision) issues.set(ip, clone(issue));
    await Promise.all([...this.ranges.values()].filter(range => {
      const state = this.state(range);
      return epochs.get(range) === range.epoch && !range.userHeld && this.plans.get(range.planId)!.batchId === batchId && !state.userPaused && !range.manual &&
        !this.cancellingPlans.has(range.planId) && state.pauseReason === "profiles-exhausted";
    }).map(range => this.resumeRange(range.planId, range.rangeId)));
    this.schedule();
  }

  async profilesChanged(): Promise<void> {
    const epochs = new Map([...this.ranges.values()].map(range => [range, range.epoch]));
    const profiles = await this.runtime.listProfiles();
    const pending: Promise<void>[] = [];
    for (const range of this.ranges.values()) {
      range.waitingProfiles = undefined;
      const state = this.state(range);
      if (epochs.get(range) !== range.epoch || range.userHeld || state.pauseReason !== "profiles-exhausted" || state.userPaused || range.manual || this.cancellingPlans.has(range.planId)) continue;
      if (profiles.some(profile => this.profileEligibleForAttempt(range, profile))) {
        pending.push(this.resumeRange(range.planId, range.rangeId));
      }
    }
    await Promise.all(pending);
    this.schedule();
  }

  async stopAutomatic(): Promise<void> {
    this.automaticStopEpoch++;
    const pending: Promise<void>[] = [];
    for (const range of this.ranges.values()) {
      if (terminal(this.state(range))) continue;
      range.manual = false;
      const state = this.state(range);
      pending.push(this.halt(range, state.userPaused ? state.pauseReason ?? "user-paused" : "automatic-off", state.userPaused, true, false));
    }
    await Promise.all(pending);
  }

  async stopForRestore(): Promise<void> {
    await this.stopAutomatic();
    await Promise.all([...this.writes.values()]);
    await Promise.all(this.slots.filter((lease): lease is WorkerLease => lease !== undefined).map(lease => this.closeLease(lease)));
  }

  async cancelRange(planId: string, rangeId: string): Promise<void> {
    const range = this.requireRange(planId, rangeId);
    if (terminal(this.state(range))) return;
    range.manual = false;
    await this.halt(range, "cancelled", true, true, false);
    await this.serialize(planId, async () => {
      this.install(await this.runtime.cancelRange(planId, rangeId));
      range.jobs?.clear();
    });
  }

  async cancelPlan(planId: string): Promise<void> {
    if (!this.plans.has(planId) && !this.writes.has(planId)) return;
    if (this.cancellingPlans.has(planId)) return;
    this.cancellingPlans.add(planId);
    try {
      if (!this.plans.has(planId)) await this.writes.get(planId);
      const ranges = [...this.ranges.values()].filter(range => range.planId === planId);
      await Promise.all(ranges.map(range => {
        range.manual = false;
        return this.halt(range, "cancelled", true, true, false);
      }));
      await this.serialize(planId, async () => {
        await this.runtime.cancelPlan(planId);
        this.plans.delete(planId);
        for (const range of ranges) this.ranges.delete(key(planId, range.rangeId));
        this.publish();
      });
    } finally {
      this.cancellingPlans.delete(planId);
    }
    this.schedule();
  }

  handleTaskChallenge(taskId: string, input: SourceAccessBlock): Promise<boolean> {
    const range = this.enrolled.get(taskId);
    const task = range?.task;
    if (!range || !task || task.owned || range.manual || !range.intent || !this.owns(range, task.epoch, task.lease)) {
      return Promise.resolve(false);
    }
    const plan = this.plans.get(range.planId)!;
    const ref = task.lease.ref;
    if (input.sourceId !== plan.pluginId || input.rangeId !== ref.rangeId || input.workerGeneration !== ref.generation ||
      (input.originTaskId !== undefined && input.originTaskId !== taskId) ||
      !Number.isSafeInteger(input.revision) || input.revision <= 0 ||
      (input.challenge.kind !== "captcha" && input.challenge.kind !== "cloudflare")) return Promise.resolve(false);
    try {
      if (sourceAccessScopeKey(input.challenge.url, plan.pluginId, ref.rangeId) !== input.scopeKey) return Promise.resolve(false);
    } catch { return Promise.resolve(false); }

    const block = clone(input);
    const epoch = ++range.epoch;
    if (plan.policies[block.challenge.kind] === "pause") range.intent = false;
    const previous = range.transition;
    const issue = this.excludeProfile(range, task.lease, block.challenge.kind);
    const cancellation = this.cancelEnrolled(range, task);
    const operation = (async () => {
      await Promise.all([this.updateRange(range, next => {
        if (terminal(next) || next.generation !== ref.generation) return;
        if (this.isEpoch(range, epoch)) {
          next.phase = "paused";
          next.pauseReason = `challenge-${block.challenge.kind}`;
        }
        next.challenge = block.challenge;
        next.attemptProfileId = null;
        addAttempt(next, task.lease.profile.id);
      }), previous, cancellation, issue]);
      if (!this.isEpoch(range, epoch)) return;
      if (this.plans.get(range.planId)!.policies[block.challenge.kind] === "pause") {
        this.notice(range, `challenge-${block.challenge.kind}`);
      } else if (!this.online) {
        range.networkHeld = true;
        await this.updateRange(range, next => { next.pauseReason = "offline"; }, epoch);
        await this.closeLease(task.lease);
      } else {
        await this.closeLease(task.lease);
      }
    })();
    range.transition = operation;
    return operation.then(() => { this.schedule(); return true; });
  }

  async networkChanged(online = this.runtime.isOnline()): Promise<void> {
    this.online = online;
    const pending: Promise<void>[] = [];
    for (const range of this.ranges.values()) {
      if (terminal(this.state(range)) || !range.intent || range.manual || this.state(range).userPaused) continue;
      if (!online) {
        range.networkHeld = true;
        pending.push(this.halt(range, "offline", false, true, true));
      } else if (range.networkHeld) {
        range.networkHeld = false;
        pending.push(this.updateRange(range, next => { next.pauseReason = null; }, range.epoch));
      }
    }
    await Promise.all(pending);
    if (online) this.schedule();
  }

  async openVerification(planId: string, rangeId: string): Promise<boolean> {
    const range = this.requireRange(planId, rangeId);
    const lease = range.worker;
    const challenge = this.state(range).challenge;
    if (!lease?.connected || lease.closing || !challenge || terminal(this.state(range))) return false;
    range.manual = true;
    await this.halt(range, "manual-verification", this.state(range).userPaused, false, range.intent);
    if (!range.manual || range.worker !== lease) return false;
    await this.runtime.showWorker(lease.ref, challenge.url);
    return true;
  }

  async finishVerification(planId: string, rangeId: string, options: { resume: boolean }): Promise<void> {
    const range = this.requireRange(planId, rangeId);
    range.manual = false;
    if (options.resume) await this.resumeRange(planId, rangeId);
    else {
      range.intent = false;
      await this.updateRange(range, next => { if (!terminal(next)) next.pauseReason = "manual-verification"; });
    }
  }

  private register(plan: VpnDownloadPlan, automatic: boolean, jobs?: ChapterDownloadJob[]): void {
    for (const state of plan.ranges) {
      this.generation = Math.max(this.generation, state.generation);
      this.ranges.set(key(plan.id, state.id), {
        planId: plan.id, rangeId: state.id, epoch: 0, intent: automatic && !state.userPaused && !terminal(state),
        manual: false, userHeld: state.userPaused, networkHeld: automatic && !this.online,
        jobs: jobs ? new Map(jobs.filter(job => state.selectedChapterIds.includes(job.id)).map(job => [job.id, clone(job)])) : null,
        transition: Promise.resolve(),
      });
    }
    this.install(plan);
  }

  private install(plan: VpnDownloadPlan): void {
    this.plans.set(plan.id, clone(plan));
    this.publish();
  }

  private publish(): void {
    this.snapshot = Object.freeze([...this.plans.values()].map(freezePlan));
    for (const listener of this.listeners) listener();
  }

  private requireRange(planId: string, rangeId: string): RangeRuntime {
    const range = this.ranges.get(key(planId, rangeId));
    if (!range) throw new Error("VPN download range is not enrolled.");
    return range;
  }

  private state(range: RangeRuntime): VpnDownloadRangeState {
    return this.plans.get(range.planId)!.ranges.find(candidate => candidate.id === range.rangeId)!;
  }

  private isEpoch(range: RangeRuntime, epoch: number): boolean {
    return this.ranges.get(key(range.planId, range.rangeId)) === range && range.epoch === epoch;
  }

  private canWork(range: RangeRuntime, epoch: number): boolean {
    const plan = this.plans.get(range.planId)!;
    return this.isEpoch(range, epoch) && range.intent && !range.manual && !range.networkHeld && this.online &&
      !this.pausedWorks.has(JSON.stringify([plan.pluginId, plan.novelId])) &&
      !this.cancellingPlans.has(range.planId) && !this.state(range).userPaused && !terminal(this.state(range));
  }

  private owns(range: RangeRuntime, epoch: number, lease: WorkerLease): boolean {
    return this.canWork(range, epoch) && range.worker === lease && this.slots[lease.ref.slot] === lease && !lease.closing;
  }

  private serialize<T>(planId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.writes.get(planId) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.writes.set(planId, settled);
    void settled.then(() => { if (this.writes.get(planId) === settled) this.writes.delete(planId); });
    return result;
  }

  private updateRange(range: RangeRuntime, update: (state: VpnDownloadRangeState, plan: VpnDownloadPlan) => void, epoch?: number, restartPass = false): Promise<void> {
    return this.serialize(range.planId, async () => {
      const current = this.plans.get(range.planId);
      if (!current || (epoch !== undefined && !this.isEpoch(range, epoch))) return;
      const next = clone(current);
      update(next.ranges.find(candidate => candidate.id === range.rangeId)!, next);
      if (JSON.stringify(current) === JSON.stringify(next)) return;
      this.install(await this.runtime.updatePlan(next, current.revision, restartPass ? { restartPassRangeId: range.rangeId } : undefined));
    });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const ranges = [...this.ranges.values()];
      let budget = this.freeSlots() - ranges.filter(range => range.dispatching).length;
      for (const range of this.dispatchOrder()) {
        if (!this.canWork(range, range.epoch) || range.run?.epoch === range.epoch) continue;
        if (!range.worker) {
          if (range.waitingProfiles?.every(id => this.profileReserved(range, id))) continue;
          if (budget <= 0 || !this.availableSlot(range)) continue;
          budget--;
          range.dispatching = true;
        }
        const run = { epoch: range.epoch };
        range.run = run;
        void this.drive(range, run.epoch)
          .catch(error => this.fail(range, run.epoch, "runtime-error", error))
          .catch(error => this.notice(range, "runtime-error", error))
          .finally(() => { range.dispatching = false; if (range.run === run) { range.run = undefined; this.schedule(); } });
      }
    });
  }

  /** Stable priority: plan creation order, then range order inside the plan. */
  private dispatchOrder(): RangeRuntime[] {
    const plans = [...this.plans.values()].sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return plans.flatMap(plan => plan.ranges.map(state => this.ranges.get(key(plan.id, state.id))).filter((range): range is RangeRuntime => range !== undefined));
  }

  private occupiedSlots(): number {
    return this.slots.filter(Boolean).length;
  }

  private freeSlots(): number {
    return Math.max(0, this.workerLimit - this.occupiedSlots());
  }

  private freeSlotIndex(): number {
    return this.slots.findIndex(lease => !lease);
  }

  private availableSlot(range: RangeRuntime): boolean {
    const cap = this.plans.get(range.planId)!.mode === "single" ? 1 : MAX_VPN_DOWNLOAD_WORKERS;
    return this.occupiedSlots() < this.workerLimit &&
      this.slots.filter(lease => lease?.owner.planId === range.planId).length < cap && this.freeSlotIndex() >= 0;
  }

  private workerAboveLimit(lease: WorkerLease): boolean {
    return this.slots.slice(0, lease.ref.slot + 1).filter(Boolean).length > this.workerLimit;
  }

  private async releaseWorkerForCapacity(range: RangeRuntime, epoch: number, lease: WorkerLease): Promise<void> {
    await this.updateRange(range, next => { next.phase = "paused"; next.pauseReason = null; }, epoch);
    if (this.owns(range, epoch, lease)) await this.closeLease(lease);
  }

  private profileReserved(range: RangeRuntime, profileId: string): boolean {
    return this.runtime.reservedProfileIds().includes(profileId) ||
      this.slots.some(lease => lease && lease.owner !== range && lease.profile.id === profileId);
  }

  /** Recent successes first, then servers that have not failed this session, in pool order otherwise. */
  private rankProfiles(profiles: readonly VpnDownloadProfile[]): VpnDownloadProfile[] {
    return [...profiles].sort((left, right) =>
      (this.connectedProfiles.get(right.id) ?? 0) - (this.connectedProfiles.get(left.id) ?? 0) ||
      (this.failedProfiles.get(left.id) ?? 0) - (this.failedProfiles.get(right.id) ?? 0));
  }

  private recordProfileResult(profile: VpnDownloadProfile, connected: boolean): void {
    if (connected) {
      this.connectedProfiles.set(profile.id, ++this.successSequence);
      this.failedProfiles.delete(profile.id);
    } else {
      this.connectedProfiles.delete(profile.id);
      this.failedProfiles.set(profile.id, (this.failedProfiles.get(profile.id) ?? 0) + 1);
    }
  }

  private loadProfileIssues(batchId: string): Promise<void> {
    if (!this.issueLoads.has(batchId)) {
      const loading = this.runtime.loadProfileIssues(batchId).then(issues => {
        this.profileIssues.set(batchId, new Map(issues.map(issue => [issue.ip, clone(issue)])));
      });
      this.issueLoads.set(batchId, loading);
      void loading.catch(() => { if (this.issueLoads.get(batchId) === loading) this.issueLoads.delete(batchId); });
    }
    return this.issueLoads.get(batchId)!;
  }

  private seedGeneration(): Promise<void> {
    this.generationSeed ??= this.runtime.generationFloor().then(floor => {
      if (!Number.isSafeInteger(floor) || floor < 0) throw new Error("Invalid native VPN worker generation floor.");
      this.generation = Math.max(this.generation, floor);
    });
    return this.generationSeed;
  }

  private profileExcluded(range: RangeRuntime, profile: VpnDownloadProfile): boolean {
    const batchId = this.plans.get(range.planId)!.batchId;
    return this.pendingExclusions.has(key(batchId, profile.ip)) || this.profileIssues.get(batchId)?.get(profile.ip)?.excluded === true;
  }

  private profileEligibleForAttempt(range: RangeRuntime, profile: VpnDownloadProfile): boolean {
    const plan = this.plans.get(range.planId)!;
    const state = this.state(range);
    const issue = this.profileIssues.get(plan.batchId)?.get(profile.ip);
    return !this.profileExcluded(range, profile) && (!state.attemptedProfileIds.includes(profile.id) ||
      issue?.excluded === false && (state.consumedReallowRevisions?.[profile.id] ?? 0) < issue.revision);
  }

  private async excludeProfile(range: RangeRuntime, lease: WorkerLease, cause: VpnDownloadProfileIssueCause): Promise<void> {
    const plan = this.plans.get(range.planId)!;
    const input: VpnDownloadProfileIssueInput = {
      batchId: plan.batchId, planId: plan.id, rangeId: range.rangeId, generation: lease.ref.generation,
      profileId: lease.profile.id, profileHash: lease.profile.hash, ip: lease.profile.ip, cause,
    };
    this.pendingExclusions.set(key(plan.batchId, input.ip), input);
    for (const waiting of this.ranges.values()) {
      if (this.plans.get(waiting.planId)?.batchId === plan.batchId) waiting.waitingProfiles = undefined;
    }
    await this.persistProfileIssue(input);
  }

  private persistProfileIssue(input: VpnDownloadProfileIssueInput): Promise<void> {
    const pendingKey = key(input.batchId, input.ip);
    const active = this.issueWrites.get(pendingKey);
    if (active) return active;
    const write = this.serialize(input.planId, () => this.runtime.recordProfileIssue(clone(input))).then(issue => {
      const issues = this.profileIssues.get(issue.batchId)!;
      if ((issues.get(issue.ip)?.revision ?? 0) < issue.revision) issues.set(issue.ip, clone(issue));
      if (this.pendingExclusions.get(pendingKey) === input) this.pendingExclusions.delete(pendingKey);
    });
    this.issueWrites.set(pendingKey, write);
    const release = () => { if (this.issueWrites.get(pendingKey) === write) this.issueWrites.delete(pendingKey); };
    void write.then(release, release);
    return write;
  }

  private async settleTransition(range: RangeRuntime): Promise<void> {
    const transition = range.transition;
    let failure: { error: unknown } | undefined;
    try { await transition; } catch (error) { failure = { error }; }
    const pending = [...this.pendingExclusions.values()].filter(issue => issue.planId === range.planId);
    if (failure && !pending.length) {
      if (!range.worker || range.worker.cleanupError !== failure.error) throw failure.error;
      await this.closeLease(range.worker);
    }
    await Promise.all(pending.map(issue => this.persistProfileIssue(issue)));
    if (failure && range.transition === transition) range.transition = Promise.resolve();
  }

  private async drive(range: RangeRuntime, epoch: number): Promise<void> {
    await range.transition;
    if (!this.canWork(range, epoch)) return;
    if (!range.jobs) {
      const jobs = await this.runtime.loadJobs(range.planId, range.rangeId);
      if (!this.canWork(range, epoch)) return;
      range.jobs = new Map(jobs.map(job => [job.id, clone(job)]));
    }
    while (this.canWork(range, epoch)) {
      const lease = range.worker?.connected ? range.worker : await this.connectRange(range, epoch);
      if (!lease || !this.owns(range, epoch, lease)) return;
      await this.updateRange(range, next => { next.phase = "running"; next.pauseReason = null; }, epoch);
      if (!this.owns(range, epoch, lease)) return;
      const profiles = await this.runtime.listProfiles();
      if (!this.owns(range, epoch, lease)) return;
      if (!profiles.some(profile => profile.id === lease.profile.id && profile.hash === lease.profile.hash)) {
        await this.closeLease(lease);
        continue;
      }
      if (!this.runtime.isOnline()) { await this.networkChanged(false); return; }
      if (this.workerAboveLimit(lease)) { await this.releaseWorkerForCapacity(range, epoch, lease); return; }
      const state = this.state(range);
      const chapterId = state.selectedChapterIds[state.checkpoint];
      if (chapterId === undefined) {
        await this.updateRange(range, next => { next.phase = "completed"; next.pauseReason = null; }, epoch);
        range.intent = false;
        await this.closeLease(lease);
        return;
      }
      const job = range.jobs.get(chapterId);
      const plan = this.plans.get(range.planId)!;
      if (!job || job.pluginId !== plan.pluginId || job.novelId !== plan.novelId) {
        throw new Error("VPN range is missing its next owned chapter job.");
      }
      const handle = this.runtime.enqueueChapter(clone(job), lease.ref, range.planId);
      const result = handle.promise.then<ChapterResult, ChapterResult>(() => ({ ok: true }), error => ({ ok: false, error }));
      const task: EnrolledChapter = {
        handle, lease, epoch, owned: false,
        settled: result.then(() => this.runtime.waitForTask(handle.id, lease.ref)),
      };
      void task.settled.catch(() => undefined);
      range.task = task;
      this.enrolled.set(handle.id, range);
      if (state.challenge && !this.runtime.requestVerification(handle.id, lease.ref, clone(state.challenge))) {
        await this.fail(range, epoch, "verification-unavailable");
        return;
      }
      const outcome = await result;
      await task.settled;
      if (task.owned || !this.owns(range, epoch, lease) || range.task !== task) return;
      this.detach(range, task);
      if (!outcome.ok) {
        if (isTaskUserCancelledError(outcome.error)) await this.halt(range, "user-paused", true, true, false);
        else if (!this.runtime.isOnline()) await this.networkChanged(false);
        else if (isPluginVpnUnavailableError(outcome.error)) {
          this.recordProfileResult(lease.profile, false);
          await this.excludeProfile(range, lease, "tunnel-lost");
          await this.updateRange(range, next => { addAttempt(next, lease.profile.id); next.attemptProfileId = null; next.phase = "paused"; }, epoch);
          await this.closeLease(lease);
          continue;
        }
        else if (isRetryableScraperFailure(outcome.error)) {
          const issue = this.profileIssues.get(plan.batchId)?.get(lease.profile.ip);
          await this.updateRange(range, next => {
            if (terminal(next) || next.generation !== lease.ref.generation || next.checkpoint !== state.checkpoint) return;
            addAttempt(next, lease.profile.id);
            next.attemptProfileId = null;
            if (this.isEpoch(range, epoch)) next.phase = "paused";
            consumeReallow(next, lease.profile.id, issue);
          });
          await this.closeLease(lease);
          if (state.challenge && plan.policies[state.challenge.kind] === "pause") {
            await this.fail(range, epoch, "download-failed", outcome.error);
            return;
          }
          continue;
        }
        else await this.fail(range, epoch, "download-failed", outcome.error);
        return;
      }
      await this.serialize(range.planId, async () => {
        if (!this.owns(range, epoch, lease)) return;
        this.install(await this.runtime.settleChapter(range.planId, range.rangeId, chapterId, lease.ref.generation));
        range.jobs!.delete(chapterId);
      });
      if (this.isEpoch(range, epoch) && terminal(this.state(range))) {
        range.intent = false;
        await this.closeLease(lease);
        return;
      }
    }
  }

  private async connectRange(range: RangeRuntime, epoch: number): Promise<WorkerLease | undefined> {
    while (this.canWork(range, epoch)) {
      const profiles = await this.runtime.listProfiles();
      if (!this.canWork(range, epoch)) return;
      if (!this.runtime.isOnline()) { await this.networkChanged(false); return; }
      const state = this.state(range);
      const plan = this.plans.get(range.planId)!;
      // A pause-policy challenge keeps the range on the server the user is asked to verify.
      const pinned = state.challenge !== null && plan.policies[state.challenge.kind] === "pause" &&
        profiles.some(profile => profile.id === state.profileId && profile.hash === state.profileHash);
      const candidates = this.rankProfiles(profiles.filter(profile => this.profileEligibleForAttempt(range, profile) &&
        (!pinned || profile.id === state.profileId && profile.hash === state.profileHash)));
      if (!candidates.length) {
        await this.fail(range, epoch, "profiles-exhausted");
        return;
      }
      const selected = candidates.find(profile => !this.profileReserved(range, profile.id));
      if (!selected) {
        // Every eligible profile is leased; wait for a release.
        range.waitingProfiles = candidates.map(profile => profile.id);
        range.dispatching = false;
        await this.updateRange(range, next => { next.phase = "paused"; next.pauseReason = null; }, epoch);
        return;
      }
      if (!this.availableSlot(range)) return;
      range.waitingProfiles = undefined;
      const slot = this.freeSlotIndex();
      if (!isVpnDownloadWorkerSlot(slot)) return;
      const candidate = clone(selected);
      const ref = Object.freeze({ rangeId: range.rangeId, slot, generation: ++this.generation });
      const lease: WorkerLease = { owner: range, ref, profile: clone(candidate), abort: new AbortController(), connected: false };
      range.worker = lease;
      range.dispatching = false;
      this.slots[slot] = lease;
      await this.updateRange(range, (next, plan) => {
        next.profileId = candidate.id;
        next.profileHash = candidate.hash;
        next.attemptProfileId = candidate.id;
        next.generation = ref.generation;
        next.phase = "connecting";
        next.pauseReason = null;
        consumeReallow(next, candidate.id, this.profileIssues.get(plan.batchId)?.get(candidate.ip));
      }, epoch);
      if (!this.owns(range, epoch, lease)) { await this.closeLease(lease); return; }
      if (this.workerAboveLimit(lease)) { await this.releaseWorkerForCapacity(range, epoch, lease); return; }
      let outcome: "connected" | "authentication-required";
      try {
        outcome = await this.runtime.connectWorker(ref, clone(candidate), lease.abort.signal);
      } catch (error) {
        if (!this.owns(range, epoch, lease)) { await this.runtime.disconnectWorker(ref); return; }
        if (!this.runtime.isOnline()) {
          await this.networkChanged(false);
          return;
        }
        if (!isPluginVpnUnavailableError(error)) {
          await this.fail(range, epoch, "runtime-error", error);
          return;
        }
        this.recordProfileResult(candidate, false);
        await this.excludeProfile(range, lease, "connection-failed");
        await this.updateRange(range, next => {
          addAttempt(next, candidate.id);
          next.attemptProfileId = null;
          next.phase = "paused";
        }, epoch);
        await this.closeLease(lease);
        if (state.challenge && plan.policies[state.challenge.kind] === "pause") {
          await this.fail(range, epoch, "download-failed", error);
          return;
        }
        continue;
      }
      if (!this.owns(range, epoch, lease)) { await this.runtime.disconnectWorker(ref); return; }
      if (!this.runtime.isOnline()) { await this.networkChanged(false); return; }
      if (outcome === "authentication-required") {
        await this.excludeProfile(range, lease, "authentication-required");
        await this.updateRange(range, next => { addAttempt(next, candidate.id); next.attemptProfileId = null; }, epoch);
        await this.fail(range, epoch, "authentication-required");
        return;
      }
      lease.connected = true;
      this.recordProfileResult(candidate, true);
      await this.updateRange(range, next => {
        next.phase = "running";
        next.pauseReason = null;
        next.attemptProfileId = null;
        if (next.challenge || next.attemptedProfileIds.length) addAttempt(next, candidate.id);
      }, epoch);
      return lease;
    }
  }

  private detach(range: RangeRuntime, task: EnrolledChapter): void {
    if (this.enrolled.get(task.handle.id) === range) this.enrolled.delete(task.handle.id);
    if (range.task === task) range.task = undefined;
  }

  private cancelEnrolled(range: RangeRuntime, task?: EnrolledChapter): Promise<void> {
    if (!task) return Promise.resolve();
    task.owned = true;
    this.enrolled.delete(task.handle.id);
    if (!task.cancellation) {
      const cancelled = this.runtime.cancelTask(task.handle.id);
      task.cancellation = Promise.all([cancelled, task.settled]).then(() => { this.detach(range, task); });
    }
    return task.cancellation;
  }

  private halt(range: RangeRuntime, reason: string, userPaused: boolean, disconnect: boolean, intent: boolean): Promise<void> {
    range.intent = intent;
    range.userHeld = userPaused;
    const epoch = ++range.epoch;
    const previous = this.settleTransition(range);
    const lease = range.worker;
    if (lease && !lease.connected) lease.abort.abort();
    const cancellation = this.cancelEnrolled(range, range.task);
    const operation = (async () => {
      await Promise.all([this.updateRange(range, next => {
        if (terminal(next)) return;
        next.phase = "paused";
        next.pauseReason = reason;
        next.userPaused = userPaused;
      }, epoch), previous, cancellation]);
      if (disconnect && lease) await this.closeLease(lease);
    })();
    range.transition = operation;
    return operation;
  }

  private closeLease(lease: WorkerLease): Promise<void> {
    if (!lease.closing) {
      lease.abort.abort();
      const closing = this.runtime.disconnectWorker(lease.ref).then(() => {
        if (this.slots[lease.ref.slot] === lease) this.slots[lease.ref.slot] = undefined;
        if (lease.owner.worker === lease) lease.owner.worker = undefined;
        this.schedule();
      });
      lease.closing = closing;
      void closing.catch(error => {
        lease.cleanupError = error;
        if (lease.closing === closing) lease.closing = undefined;
      });
    }
    return lease.closing;
  }

  private async fail(range: RangeRuntime, epoch: number, reason: string, error?: unknown): Promise<void> {
    if (!this.isEpoch(range, epoch)) return;
    const stopped = this.halt(range, reason, false, true, false);
    this.notice(range, reason, error);
    await stopped;
  }

  private notice(range: RangeRuntime, reason: string, error?: unknown): void {
    this.runtime.notice({ planId: range.planId, rangeId: range.rangeId, reason, ...(error === undefined ? {} : { error }) });
  }
}
