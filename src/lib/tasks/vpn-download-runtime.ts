import { listChaptersByNovel } from "../../db/queries/chapter";
import {
  cancelPendingVpnDownloadBatch, cancelPendingVpnDownloadJobs,
  enqueuePendingVpnDownloadJobs, listPendingVpnDownloadJobs,
  setPendingVpnDownloadJobsPaused,
} from "../../db/queries/chapter-download-queue";
import {
  cancelVpnDownloadPlan, cancelVpnDownloadRange as cancelStoredRange, createVpnDownloadPlan,
  getVpnDownloadRangeJobs, listVpnDownloadPlans,
  settleVpnDownloadChapter, updateVpnDownloadPlan,
} from "../../db/queries/vpn-download-plans";
import { listVpnDownloadProfileIssues, recordVpnDownloadProfileIssue, reallowVpnDownloadProfile } from "../../db/queries/vpn-download-profile-issues";
import { cancelSourceAccessWait } from "./source-access-coordinator";
import { useVpnDownloadStore } from "../../store/vpn-download";
import { androidCloseVpnDownloadWorker, androidConfigureVpnDownloadWorker, androidShowVpnDownloadWorker } from "../android-scraper";
import { describeError } from "../errors";
import { isNetworkOnline, useNetworkStore } from "../network";
import { getPluginVpnStatus, PLUGIN_VPN_PROFILE_RELEASED_EVENT } from "../plugin-vpn";
import { connectPluginVpnDownloadWorker, disconnectPluginVpnDownloadWorker, getPluginVpnDownloadGenerationFloor, stopPluginVpnDownloadWorkers } from "../plugin-vpn-download-workers";
import { listSavedPluginVpnProfiles, SAVED_PLUGIN_VPN_PROFILES_CHANGED_EVENT, type SavedVpnProfile } from "../plugin-vpn-profiles";
import { isAndroidRuntime, isTauriRuntime } from "../tauri-runtime";
import { installChapterDownloadBatchInterceptor } from "./chapter-download-batch-interceptor";
import { cancelChapterDownloadRequest, getChapterDownloadRequestSnapshot, subscribeChapterDownloadRequests } from "./chapter-download-requests";
import { beginChapterDownloadVpnHandover, cancelChapterDownloadTasks, discardQueuedChapterDownloads, enqueueVpnDownloadChapter, publishVpnDownloadBatchProgress, type ChapterDownloadVpnHandover, type ChapterDownloadBatchHandle, type ChapterDownloadBatchJob, type ChapterDownloadBatchResult, type ChapterDownloadJob } from "./chapter-download";
import { taskScheduler } from "./scheduler";
import type { TaskHandle } from "./task-types";
import { VpnDownloadCoordinator, type VpnDownloadRuntime } from "./vpn-download-coordinator";
import type { VpnDownloadDraftWork, VpnDownloadHandoverWork, VpnDownloadRuntimeSnapshot } from "./vpn-download-drafts";
import { planVpnDownloadRanges, type VpnDownloadRangeAssignment } from "./vpn-download-ranges";
import type { VpnDownloadLaunchOptions, VpnDownloadPlan, VpnDownloadRunSnapshot, VpnDownloadWorkerRef } from "./vpn-download-types";
import { MAX_VPN_DOWNLOAD_WORKERS } from "./vpn-download-types";
import { registerVpnDownloadWorkerContext, vpnDownloadExecutor } from "./vpn-worker-context";

interface PendingBatch {
  id: string;
  total: number;
  cancelled: number;
  materializing: boolean;
  draftIds: Set<string>;
  planIds: Set<string>;
  planResults: Map<string, ChapterDownloadBatchResult>;
  resolve: (result: ChapterDownloadBatchResult) => void;
  reject: (error: unknown) => void;
  runBatchId: string;
  jobs: ChapterDownloadJob[];
  handle?: ChapterDownloadBatchHandle;
  cancelRequested: boolean;
  persistence: Promise<void>;
  cancellation?: Promise<void>;
}

interface PendingDraft {
  work: VpnDownloadDraftWork;
  jobs: ChapterDownloadJob[];
  starting: false | "profiles" | "publishing";
  planId?: string;
  cancelling?: Promise<void>;
  preparation?: Promise<void>;
}

interface WorkerSession {
  planId: string;
  worker: VpnDownloadWorkerRef;
  sourceId: string;
  profileId: string;
  browserStarted: boolean;
  unregister?: () => void;
  closing?: Promise<void>;
}

interface ActiveRun {
  id: string;
  options: VpnDownloadLaunchOptions;
  status: VpnDownloadRunSnapshot["status"];
  handover?: ChapterDownloadVpnHandover;
  handoverReady?: Promise<ChapterDownloadVpnHandover>;
  originalPlanIds: Set<string>;
  transfers: Set<Promise<void>>;
  receivedWork: boolean;
  resumeRangeIds: Set<string>;
  waitingHandover: Map<number, ChapterDownloadJob>;
  cancellation?: Promise<void>;
}

const batches = new Map<string, PendingBatch>();
const drafts = new Map<string, PendingDraft>();
const sessions = new Map<string, WorkerSession>();
const ownedUnfinishedChapterIds = new Set<number>();
const listeners = new Set<() => void>();
const chapterObservers = new Map<string, () => void>();
const pausedWorks = new Set<string>();
let reservedProfiles: string[] = [];
let automaticStopEpoch = 0;
let deviceRestore: symbol | undefined;
let initialization: Promise<void> | undefined;
let activeRun: ActiveRun | undefined;
let profileRevision = 0;
let snapshot: VpnDownloadRuntimeSnapshot = {
  drafts: [], plans: [], loading: true, error: null,
  capabilities: { supported: false, parallelSupported: false, maxWorkers: 0 }, chapterLabels: {},
};

function publish(update: Partial<VpnDownloadRuntimeSnapshot> = {}): void {
  const plans = coordinator.getPlans();
  const currentSessions = [...sessions.values()];
  ownedUnfinishedChapterIds.clear();
  for (const draft of drafts.values()) for (const job of draft.jobs) ownedUnfinishedChapterIds.add(job.id);
  for (const plan of plans) for (const range of plan.ranges) {
    if (range.phase !== "cancelled") for (const id of range.selectedChapterIds.slice(range.checkpoint)) ownedUnfinishedChapterIds.add(id);
  }
  const handover = new Map<string, VpnDownloadHandoverWork>();
  for (const job of activeRun?.waitingHandover.values() ?? []) {
    ownedUnfinishedChapterIds.add(job.id);
    const id = JSON.stringify([job.pluginId, job.novelId]);
    const work = handover.get(id) ?? { id, pluginId: job.pluginId, novelId: job.novelId!, title: job.novelName ?? job.title, chapterIds: [] };
    handover.set(id, { ...work, chapterIds: [...work.chapterIds, job.id], userPaused: pausedWorks.has(id) });
  }
  snapshot = { ...snapshot, ...update, drafts: [...drafts.values()].map(draft => draft.work), plans,
    run: activeRun ? { id: activeRun.id, ...activeRun.options, status: activeRun.status,
      activeWorkers: currentSessions.filter(session => !session.closing && session.unregister).length,
      connectingWorkers: currentSessions.filter(session => !session.closing && !session.unregister).length,
      closingWorkers: currentSessions.filter(session => session.closing).length } : null,
    ownedChapterIds: [...ownedUnfinishedChapterIds], handover: [...handover.values()],
  };
  for (const listener of listeners) listener();
}

function report(error: unknown): void { publish({ error: describeError(error) }); }

async function availableProfiles(): Promise<readonly SavedVpnProfile[]> {
  const [vault, status] = await Promise.all([listSavedPluginVpnProfiles(), getPluginVpnStatus()]);
  if (vault.cleanupError) throw new Error(vault.cleanupError);
  reservedProfiles = status.phase !== "disabled" && status.profile
    ? vault.profiles.filter(profile => profile.hash === status.profile!.hash || profile.ip === status.profile!.remoteHost).map(profile => profile.id) : [];
  return vault.profiles;
}

async function disconnectWorker(worker: VpnDownloadWorkerRef): Promise<void> {
  const executor = vpnDownloadExecutor(worker);
  const session = sessions.get(executor);
  if (!session) { await disconnectPluginVpnDownloadWorker(worker); return; }
  session.closing ??= Promise.all([
    session.browserStarted ? androidCloseVpnDownloadWorker(worker, session.sourceId) : Promise.resolve(),
    disconnectPluginVpnDownloadWorker(worker),
  ]).then(() => {
    session.unregister?.();
    if (sessions.get(executor) === session) sessions.delete(executor);
    profileRevision++;
    syncBatches();
    retryPendingDrafts();
  });
  const closing = session.closing;
  publish();
  try { await closing; } catch (error) {
    if (session.closing === closing) session.closing = undefined;
    throw error;
  }
}

const adapter: VpnDownloadRuntime = {
  generationFloor: getPluginVpnDownloadGenerationFloor,
  loadPlans: listVpnDownloadPlans,
  createPlan: createVpnDownloadPlan,
  loadJobs: getVpnDownloadRangeJobs,
  updatePlan: updateVpnDownloadPlan,
  settleChapter: settleVpnDownloadChapter,
  cancelRange: cancelStoredRange,
  cancelPlan: cancelVpnDownloadPlan,
  listProfiles: availableProfiles,
  loadProfileIssues: listVpnDownloadProfileIssues,
  recordProfileIssue: recordVpnDownloadProfileIssue,
  reallowProfile: reallowVpnDownloadProfile,
  reservedProfileIds: () => reservedProfiles,
  connectWorker: async (worker, profile, signal) => {
    if (!snapshot.capabilities.supported) throw new Error("Isolated VPN download workers are not supported on this device.");
    const plan = coordinator.getPlans().find(plan => plan.ranges.some(range => range.id === worker.rangeId));
    if (!plan) throw new Error("VPN worker has no enrolled plan.");
    const session: WorkerSession = { planId: plan.id, worker, sourceId: plan.pluginId, profileId: profile.id, browserStarted: false };
    sessions.set(vpnDownloadExecutor(worker), session);
    publish();
    const abort = () => { void disconnectPluginVpnDownloadWorker(worker).catch(report); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new DOMException("VPN worker cancelled.", "AbortError");
      const status = await connectPluginVpnDownloadWorker(worker, profile);
      if (signal.aborted) throw new DOMException("VPN worker cancelled.", "AbortError");
      if (!status.supported || status.worker.rangeId !== worker.rangeId || status.worker.generation !== worker.generation || status.worker.slot !== worker.slot) {
        throw new Error("Native VPN worker identity changed.");
      }
      if (status.phase !== "connected") {
        if (/auth|credential|username|password/i.test(status.error ?? "")) return "authentication-required";
        throw new Error(status.error ?? "The VPN worker did not connect.");
      }
      if (status.profile?.id !== profile.id || status.profile.hash !== profile.hash) throw new Error("Native VPN profile identity changed.");
      session.browserStarted = true;
      await androidConfigureVpnDownloadWorker(worker, { sourceId: plan.pluginId, profileId: profile.id, proxyPort: status.proxyPort });
      if (signal.aborted || session.closing) throw new DOMException("VPN worker cancelled.", "AbortError");
      session.unregister = registerVpnDownloadWorkerContext(worker);
      return "connected";
    } finally { signal.removeEventListener("abort", abort); }
  },
  disconnectWorker,
  showWorker: async (worker) => {
    const session = sessions.get(vpnDownloadExecutor(worker));
    if (!session || session.closing) throw new Error("VPN worker browser is unavailable.");
    await androidShowVpnDownloadWorker(worker, session.sourceId);
  },
  enqueueChapter: (job, worker, planId) => {
    if (job.vpnPlanId !== planId || job.vpnRangeId !== worker.rangeId) throw new Error("VPN chapter ownership changed.");
    // The coordinator serializes the durable checkpoint only after executor cleanup.
    return enqueueVpnDownloadChapter(job, worker, async () => undefined);
  },
  cancelTask: id => {
    for (const block of taskScheduler.getSnapshot().sourceAccessBlocks) {
      if (block.rangeId && (block.originTaskId === id || block.verificationTaskId === id)) {
        cancelSourceAccessWait(block.scopeKey, block.revision);
      }
    }
    taskScheduler.cancel(id);
  },
  waitForTask: id => taskScheduler.waitForSourceTaskSettlement(id),
  requestVerification: (id, worker, challenge) => taskScheduler.beginVpnSourceAccessVerification(id, worker, challenge),
  isOnline: isNetworkOnline,
  notice: notice => { if (notice.error !== undefined) report(notice.error); },
};

const coordinator = new VpnDownloadCoordinator(adapter);

function syncBatches(): void {
  const plans = coordinator.getPlans();
  publish();
  for (const batch of batches.values()) {
    const owned = new Map(plans.filter(plan => batch.planIds.has(plan.id)).map(plan => [plan.id, plan]));
    const ranges = [...owned.values()].flatMap(plan => plan.ranges);
    let succeeded = 0;
    let cancelled = batch.cancelled;
    for (const id of batch.planIds) {
      const plan = owned.get(id);
      let result = batch.planResults.get(id);
      if (plan) {
        result = {
          total: plan.ranges.reduce((count, range) => count + range.selectedChapterIds.length, 0),
          succeeded: plan.ranges.reduce((count, range) => count + range.checkpoint, 0), failed: 0,
          cancelled: plan.ranges.filter(range => range.phase === "cancelled")
            .reduce((count, range) => count + range.selectedChapterIds.length - range.checkpoint, 0),
        };
        batch.planResults.set(id, result);
      } else if (result) result.cancelled = result.total - result.succeeded;
      if (result) { succeeded += result.succeeded; cancelled += result.cancelled; }
    }
    const workersActive = [...sessions.values()].some(session => batch.planIds.has(session.planId));
    const active = batch.materializing || batch.draftIds.size > 0 || workersActive || ranges.some(range => range.phase !== "completed" && range.phase !== "cancelled");
    const result = { total: batch.total, succeeded, failed: 0, cancelled };
    if (batch.planIds.size) publishVpnDownloadBatchProgress({ batchId: batch.id, active, progress: { ...result, current: succeeded + cancelled } });
    if (!active) { batches.delete(batch.id); batch.resolve(result); }
  }
  if (activeRun?.status === "running" && activeRun.receivedWork && activeRun.transfers.size === 0 &&
    batches.size === 0 && sessions.size === 0 && !getChapterDownloadRequestSnapshot().some(request => request.phase !== "failed") &&
    plans.every(plan => plan.ranges.every(range => range.phase === "completed" || range.phase === "cancelled"))) {
    activeRun.status = "completed";
    activeRun.handover?.release();
    publish();
  }
}
coordinator.subscribe(syncBatches);

function capabilities(): VpnDownloadRuntimeSnapshot["capabilities"] {
  const unsupported = { supported: false, parallelSupported: false, maxWorkers: 0 };
  if (!isAndroidRuntime()) return unsupported;
  try {
    const value: unknown = JSON.parse(window.__NoreaAndroidVpnWorkers?.capabilities() ?? "null");
    if (!value || typeof value !== "object" || !("supported" in value) || value.supported !== true ||
      !("maxWorkers" in value) || typeof value.maxWorkers !== "number" || !Number.isInteger(value.maxWorkers) ||
      value.maxWorkers < 1 || value.maxWorkers > MAX_VPN_DOWNLOAD_WORKERS ||
      !("parallelSupported" in value) || value.parallelSupported !== true) return unsupported;
    return { supported: true, parallelSupported: true, maxWorkers: value.maxWorkers };
  } catch { return unsupported; }
}

export function initializeVpnDownloadRuntime(): Promise<void> {
  initialization ??= (async () => {
    publish({ capabilities: capabilities() });
    const settings = useVpnDownloadStore.getState();
    coordinator.setWorkerLimit(settings.mode === "single" ? 1 : Math.min(settings.workerCount, snapshot.capabilities.maxWorkers || MAX_VPN_DOWNLOAD_WORKERS));
    if (!isTauriRuntime()) { publish({ loading: false }); return; }
    await coordinator.restore();
    for (const plan of coordinator.getPlans()) if (plan.ranges.some(range => range.userPaused && range.pauseReason === "work-paused")) {
      pausedWorks.add(JSON.stringify([plan.pluginId, plan.novelId]));
    }
    const pending = await listPendingVpnDownloadJobs();
    const restored = new Map<string, ChapterDownloadJob[]>();
    for (const { job } of pending) {
      if (job.vpnWorkPaused) pausedWorks.add(JSON.stringify([job.pluginId, job.novelId]));
      const group = restored.get(job.vpnBatchId!) ?? [];
      group.push(job); restored.set(job.vpnBatchId!, group);
    }
    for (const [batchId, jobs] of restored) stageBatch({ jobs, title: jobs[0]?.novelName ?? jobs[0]?.title ?? "VPN downloads" }, batchId, false);
    if (!activeRun && (pending.length || coordinator.getPlans().some(plan => plan.ranges.some(range => range.phase !== "completed" && range.phase !== "cancelled")))) {
      const settings = useVpnDownloadStore.getState();
      activeRun = { id: pending[0]?.job.vpnBatchId ?? coordinator.getPlans().find(plan => plan.ranges.some(range => range.phase !== "completed" && range.phase !== "cancelled"))?.batchId ?? `vpn-run-${crypto.randomUUID()}`,
        options: { workerCount: settings.workerCount, captchaPolicy: settings.captchaPolicy, cloudflarePolicy: settings.cloudflarePolicy },
        status: "interrupted", originalPlanIds: new Set(coordinator.getPlans().map(plan => plan.id)), transfers: new Set(), receivedWork: true, resumeRangeIds: new Set(), waitingHandover: new Map() };
    }
    const labels: Record<string, Record<number, string>> = {};
    for (const plan of coordinator.getPlans()) {
      const catalog = await listChaptersByNovel(plan.novelId);
      labels[plan.id] = Object.fromEntries(catalog.map(chapter => [chapter.id, chapter.name]));
    }
    publish({ loading: false, chapterLabels: labels });
    const seen = new Set<string>();
    subscribeChapterDownloadRequests(syncBatches);
    taskScheduler.subscribe(() => {
      for (const block of taskScheduler.getSnapshot().sourceAccessBlocks) {
        if (!block.rangeId || !block.originTaskId || block.verificationRequested || block.verificationTaskId) continue;
        const identity = JSON.stringify([block.scopeKey, block.revision, block.originTaskId, block.workerGeneration]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        queueMicrotask(() => { void coordinator.handleTaskChallenge(block.originTaskId!, block).catch(report); });
      }
    });
    useNetworkStore.subscribe((next, previous) => {
      if (next.revision === previous.revision && next.connectivity === previous.connectivity) return;
      void (async () => {
        if (previous.connectivity === "online" && next.revision !== previous.revision) await coordinator.networkChanged(false);
        await coordinator.networkChanged(next.connectivity === "online");
      })().catch(report);
    });
    useVpnDownloadStore.subscribe((next, previous) => {
      coordinator.setWorkerLimit(next.mode === "single" ? 1 : Math.min(next.workerCount, snapshot.capabilities.maxWorkers || MAX_VPN_DOWNLOAD_WORKERS));
      if (next.mode === "off" && previous.mode !== "off") {
        automaticStopEpoch++;
        if (activeRun && ["starting", "running"].includes(activeRun.status)) { holdRunAdmission(activeRun); publish(); }
        void coordinator.stopAutomatic().catch(report);
      }
    });
    window.addEventListener(SAVED_PLUGIN_VPN_PROFILES_CHANGED_EVENT, () => {
      profileRevision++;
      if (!deviceRestore) { void coordinator.profilesChanged().catch(report); retryPendingDrafts(); }
    });
    window.addEventListener(PLUGIN_VPN_PROFILE_RELEASED_EVENT, () => {
      profileRevision++;
      if (deviceRestore || activeRun?.status !== "running") return;
      void coordinator.profilesChanged().catch(report);
      retryPendingDrafts();
    });
    window.addEventListener("norea-plugin-vpn-explicit-off", () => {
      useVpnDownloadStore.getState().setMode("off");
      void Promise.all([coordinator.stopAutomatic(), stopPluginVpnDownloadWorkers()]).catch(report);
    });
    window.addEventListener("norea-vpn-worker-browser-hidden", event => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object" || !("queue" in detail) || !("sourceId" in detail)) return;
      const session = typeof detail.queue === "string" ? sessions.get(detail.queue) : undefined;
      if (!session || session.sourceId !== detail.sourceId || session.closing) return;
      const plan = coordinator.getPlans().find(plan => plan.pluginId === session.sourceId && plan.ranges.some(range => range.id === session.worker.rangeId && range.generation === session.worker.generation && range.pauseReason === "manual-verification"));
      if (plan) void coordinator.finishVerification(plan.id, session.worker.rangeId, { resume: true }).catch(report);
    });
  })().catch(error => { publish({ loading: false, error: describeError(error) }); throw error; });
  return initialization;
}

export function getVpnDownloadRuntimeSnapshot(): VpnDownloadRuntimeSnapshot { return snapshot; }
export function subscribeVpnDownloadRuntime(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}

function requireNoDeviceRestore(): void {
  if (deviceRestore) throw new Error("VPN downloads are suspended for device restore.");
}

function holdRunAdmission(run: ActiveRun): void {
  run.status = "paused";
  for (const plan of coordinator.getPlans()) for (const range of plan.ranges) {
    if (!range.userPaused && range.phase !== "completed" && range.phase !== "cancelled") {
      run.resumeRangeIds.add(JSON.stringify([plan.id, range.id]));
    }
  }
}

export async function suspendVpnDownloadsForRestore(): Promise<() => void> {
  requireNoDeviceRestore();
  const hold = Symbol();
  deviceRestore = hold;
  automaticStopEpoch++;
  const run = activeRun;
  if (run && ["starting", "running"].includes(run.status)) holdRunAdmission(run);
  publish();
  const release = () => { if (deviceRestore === hold) deviceRestore = undefined; };
  try {
    await initializeVpnDownloadRuntime();
    await coordinator.stopForRestore();
    await run?.handoverReady;
    await Promise.all(run?.transfers ?? []);
    await Promise.all([...batches.values()].map(batch => batch.persistence));
    await Promise.all([...sessions.values()].map(session => disconnectWorker(session.worker)));
    await stopPluginVpnDownloadWorkers();
    return release;
  } catch (error) { release(); throw error; }
}

function validateLaunchOptions(options: VpnDownloadLaunchOptions): void {
  if (!Number.isInteger(options.workerCount) || options.workerCount < 1 || options.workerCount > MAX_VPN_DOWNLOAD_WORKERS ||
    !["pause", "nextProfile"].includes(options.captchaPolicy) || !["pause", "nextProfile"].includes(options.cloudflarePolicy)) {
    throw new Error("Invalid VPN download launch options.");
  }
}

function canAdmitRunWork(run: ActiveRun): boolean {
  return activeRun === run && !deviceRestore && ["starting", "running", "paused"].includes(run.status);
}

export async function startVpnDownloadRun(options: VpnDownloadLaunchOptions): Promise<void> {
  validateLaunchOptions(options);
  requireNoDeviceRestore();
  if (activeRun && (["starting", "running", "cancelling"].includes(activeRun.status) ||
    (activeRun.status === "paused" && activeRun.handover))) throw new Error("A VPN download run is already active. Resume or cancel it first.");
  const run: ActiveRun = { id: activeRun && ["paused", "interrupted"].includes(activeRun.status) ? activeRun.id : `vpn-run-${crypto.randomUUID()}`,
    options: { ...options }, status: "starting", originalPlanIds: new Set(), transfers: new Set(), receivedWork: false, resumeRangeIds: new Set(), waitingHandover: new Map() };
  const epoch = automaticStopEpoch;
  const current = () => activeRun === run && run.status === "running" && !deviceRestore && epoch === automaticStopEpoch;
  activeRun = run;
  publish();
  try {
    run.handoverReady = beginChapterDownloadVpnHandover().then(handover => {
      run.handover = handover;
      for (const pending of handover.pending) run.waitingHandover.set(pending.job.job.id, pending.job.job);
      publish();
      return handover;
    });
    void run.handoverReady.catch(() => undefined);
    await initializeVpnDownloadRuntime();
    if (!snapshot.capabilities.supported) throw new Error("Isolated VPN downloads are not supported on this device.");
    if (activeRun !== run || deviceRestore || !["starting", "running"].includes(run.status)) return;
    const settings = useVpnDownloadStore.getState();
    settings.setWorkerCount(options.workerCount);
    settings.setCaptchaPolicy(options.captchaPolicy);
    settings.setCloudflarePolicy(options.cloudflarePolicy);
    settings.setMode(options.workerCount === 1 ? "single" : "parallel");
    run.originalPlanIds = new Set(coordinator.getPlans().map(plan => plan.id));
    const handover = await run.handoverReady;
    const admitReady = async () => {
      if (!canAdmitRunWork(run)) return;
      const jobs = await handover.commitReady(run.id);
      if (!canAdmitRunWork(run)) return;
      if (jobs.length) {
        run.receivedWork = true;
        const handle = stageBatch({ jobs, title: "VPN downloads" }, run.id, false);
        await handle.materialized;
      }
    };
    const initial = admitReady();
    run.transfers.add(initial);
    try { await initial; } finally { run.transfers.delete(initial); }
    if (!canAdmitRunWork(run)) return;
    for (const pending of handover.pending) {
      const transfer = pending.settled.then(async () => {
        run.waitingHandover.delete(pending.job.job.id);
        await admitReady();
      }).catch(report).finally(() => { run.transfers.delete(transfer); syncBatches(); });
      run.transfers.add(transfer);
    }
    if (run.status !== "paused") run.status = "running";
    run.receivedWork ||= batches.size > 0 || run.originalPlanIds.size > 0 || run.transfers.size > 0;
    const resuming = (async () => {
      for (const plan of coordinator.getPlans()) {
        for (const range of plan.ranges) {
          if (!current()) return;
          if (range.phase === "paused" && !range.userPaused) await coordinator.resumeRange(plan.id, range.id);
        }
      }
    })();
    run.transfers.add(resuming);
    try { await resuming; } finally { run.transfers.delete(resuming); }
    if (current()) { resetFailedDrafts(); retryPendingDrafts(); }
    publish();
  } catch (error) {
    if (!["cancelling", "cancelled"].includes(run.status)) run.status = "paused";
    await run.handoverReady?.catch(() => undefined);
    if (!["cancelling", "cancelled"].includes(run.status)) {
      run.handover?.release();
      run.handover = undefined;
      run.handoverReady = undefined;
      run.waitingHandover.clear();
    }
    report(error);
    throw error;
  }
}

export async function pauseVpnDownloadRun(): Promise<void> {
  if (!activeRun || !["starting", "running"].includes(activeRun.status)) return;
  holdRunAdmission(activeRun);
  automaticStopEpoch++;
  publish();
  await coordinator.stopAutomatic();
}

export async function pauseVpnDownloadWork(pluginId: string, novelId: number): Promise<void> {
  pausedWorks.add(JSON.stringify([pluginId, novelId]));
  const pending = [...drafts.values()].filter(draft => draft.work.pluginId === pluginId && draft.work.novelId === novelId);
  for (const draft of pending) {
    draft.work = { ...draft.work, userPaused: true, phase: "paused" };
    draft.jobs = draft.jobs.map(job => ({ ...job, vpnWorkPaused: true }));
  }
  publish();
  await Promise.all([
    coordinator.pauseWork(pluginId, novelId),
    ...pending.map(async draft => {
      const batch = batches.get(draft.work.batchId);
      await batch?.persistence;
      if (batch) await setPendingVpnDownloadJobsPaused(batch.runBatchId, draft.jobs.map(job => job.id), true);
    }),
  ]);
}

export async function resumeVpnDownloadWork(pluginId: string, novelId: number): Promise<void> {
  requireNoDeviceRestore();
  const run = activeRun;
  const epoch = automaticStopEpoch;
  const current = () => activeRun === run && run?.status === "running" && !deviceRestore && epoch === automaticStopEpoch;
  if (!current()) throw new Error("Resume the VPN run before resuming its work.");
  const pending = [...drafts.values()].filter(draft => draft.work.pluginId === pluginId && draft.work.novelId === novelId);
  for (const draft of pending) {
    const batch = batches.get(draft.work.batchId);
    await batch?.persistence;
    if (batch) await setPendingVpnDownloadJobsPaused(batch.runBatchId, draft.jobs.map(job => job.id), false);
  }
  if (!current()) return;
  pausedWorks.delete(JSON.stringify([pluginId, novelId]));
  for (const draft of pending) {
    draft.work = { ...draft.work, userPaused: false, phase: "preparing", error: null };
    draft.jobs = draft.jobs.map(({ vpnWorkPaused: _paused, ...job }) => job);
  }
  await coordinator.resumeWork(pluginId, novelId, current);
  if (current()) retryPendingDrafts();
  publish();
}

function releaseFinishedWorkHold(pluginId: string, novelId: number): void {
  if ([...drafts.values()].some(draft => draft.work.pluginId === pluginId && draft.work.novelId === novelId) ||
    [...activeRun?.waitingHandover.values() ?? []].some(job => job.pluginId === pluginId && job.novelId === novelId) ||
    coordinator.getPlans().some(plan => plan.pluginId === pluginId && plan.novelId === novelId &&
      plan.ranges.some(range => range.phase !== "completed" && range.phase !== "cancelled"))) return;
  pausedWorks.delete(JSON.stringify([pluginId, novelId]));
  coordinator.clearWorkHold(pluginId, novelId);
}

export async function resumeVpnDownloadRun(): Promise<void> {
  await initializeVpnDownloadRuntime();
  requireNoDeviceRestore();
  if (!activeRun) throw new Error("There is no VPN download run to resume.");
  if (activeRun.status === "interrupted" || (activeRun.status === "paused" && !activeRun.handover)) { await startVpnDownloadRun(activeRun.options); return; }
  if (activeRun.status !== "paused") return;
  const run = activeRun;
  const epoch = automaticStopEpoch;
  run.status = "running";
  useVpnDownloadStore.getState().setMode(run.options.workerCount === 1 ? "single" : "parallel");
  const current = () => activeRun === run && run.status === "running" && !deviceRestore && epoch === automaticStopEpoch;
  const resuming = (async () => {
    const ready = await run.handover?.commitReady(run.id);
    if (!current()) return;
    if (ready?.length) { run.receivedWork = true; stageBatch({ jobs: ready, title: "VPN downloads" }, run.id, false); }
    const pending = await listPendingVpnDownloadJobs();
    if (!current()) return;
    const unassigned = new Map<string, ChapterDownloadJob[]>();
    for (const { job } of pending) {
      if (ownedUnfinishedChapterIds.has(job.id)) continue;
      const group = unassigned.get(job.vpnBatchId!) ?? [];
      group.push(job); unassigned.set(job.vpnBatchId!, group);
    }
    for (const [batchId, jobs] of unassigned) {
      run.receivedWork = true;
      stageBatch({ jobs, title: jobs[0]?.novelName ?? "VPN downloads" }, batchId, false);
    }
    for (const plan of coordinator.getPlans()) {
      for (const range of plan.ranges) {
        if (!current()) return;
        const key = JSON.stringify([plan.id, range.id]);
        if (range.phase === "paused" && (!range.userPaused || run.resumeRangeIds.has(key))) {
          await coordinator.resumeRange(plan.id, range.id);
          run.resumeRangeIds.delete(key);
        }
      }
    }
    if (current()) { resetFailedDrafts(); retryPendingDrafts(); }
  })();
  run.transfers.add(resuming);
  try { await resuming; }
  catch (error) {
    if (current()) {
      holdRunAdmission(run);
      automaticStopEpoch++;
      await coordinator.stopAutomatic();
    }
    report(error);
    throw error;
  }
  finally { run.transfers.delete(resuming); syncBatches(); }
}

export async function cancelVpnDownloadRun(): Promise<void> {
  const run = activeRun;
  if (!run || run.status === "cancelled") return;
  if (run.cancellation) return run.cancellation;
  run.status = "cancelling";
  automaticStopEpoch++;
  publish();
  const cancellation = (async () => {
    for (const request of getChapterDownloadRequestSnapshot()) if (request.phase !== "failed") cancelChapterDownloadRequest(request.id);
    await coordinator.stopAutomatic();
    await run.handoverReady?.catch(() => undefined);
    const ordinary = run.handover?.jobs.map(row => row.job.id) ?? [];
    if (ordinary.length) {
      await cancelChapterDownloadTasks(ordinary);
      await discardQueuedChapterDownloads(ordinary);
    }
    await Promise.all(run.transfers);
    const requested = [...batches.values()];
    for (const batch of requested) cancelBatch(batch.id);
    await Promise.all(requested.map(batch => batch.cancellation));
    for (const plan of coordinator.getPlans()) {
      if (!run.originalPlanIds.has(plan.id)) continue;
      for (const range of plan.ranges) if (range.phase !== "completed" && range.phase !== "cancelled") await coordinator.cancelRange(plan.id, range.id);
    }
    await cancelPendingVpnDownloadBatch(run.id);
    run.handover?.release();
    run.waitingHandover.clear();
    pausedWorks.clear(); coordinator.clearWorkHolds();
    run.status = "cancelled";
  })();
  run.cancellation = cancellation;
  try { await cancellation; }
  catch (error) {
    if (run.cancellation === cancellation) run.cancellation = undefined;
    run.status = "paused";
    report(error);
    throw error;
  } finally { publish(); }
}

export async function cancelVpnDownloadHandoverWork(workId: string): Promise<void> {
  const run = activeRun;
  if (!run) return;
  const jobs = [...run.waitingHandover.values()].filter(job => JSON.stringify([job.pluginId, job.novelId]) === workId);
  const ids = jobs.map(job => job.id);
  if (!ids.length) return;
  await cancelChapterDownloadTasks(ids);
  for (const id of ids) run.waitingHandover.delete(id);
  if (jobs[0]?.novelId) releaseFinishedWorkHold(jobs[0].pluginId, jobs[0].novelId);
  publish();
}

function enqueueBatch(request: ChapterDownloadBatchJob): ChapterDownloadBatchHandle | null {
  requireNoDeviceRestore();
  if (!activeRun || !["starting", "running", "paused"].includes(activeRun.status) || request.persist === false) return null;
  activeRun.receivedWork = true;
  return stageBatch(request, activeRun.id, true);
}

function enqueueSingleChapter(job: ChapterDownloadJob): TaskHandle<void> | null {
  const observing = ownedUnfinishedChapterIds.has(job.id);
  const existingPlanIds = new Set(coordinator.getPlans().filter(plan => plan.ranges.some(range =>
    range.phase !== "cancelled" && range.selectedChapterIds.slice(range.checkpoint).includes(job.id))).map(plan => plan.id));
  const batch = enqueueBatch({ jobs: [job], title: job.novelName ?? job.title });
  if (!batch) return null;
  const owner = batches.get(batch.id);
  const id = `vpn-chapter-${crypto.randomUUID()}`;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  let settled = false;
  let unsubscribe = () => {};
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true; unsubscribe(); chapterObservers.delete(id);
    if (error) reject(error); else resolve();
  };
  const cancelled = () => new DOMException("Chapter download cancelled.", "AbortError");
  const check = () => {
    for (const plan of coordinator.getPlans()) {
      if (!owner?.planIds.has(plan.id) && !existingPlanIds.has(plan.id)) continue;
      for (const range of plan.ranges) {
        const index = range.selectedChapterIds.indexOf(job.id);
        if (index < 0) continue;
        if (range.checkpoint > index) finish();
        else if (range.phase === "cancelled") finish(cancelled());
      }
    }
  };
  unsubscribe = subscribeVpnDownloadRuntime(check);
  chapterObservers.set(id, () => {
    if (!observing) cancelBatch(batch.id);
    finish(cancelled());
  });
  void batch.materialized.catch(finish);
  void batch.promise.then(result => { if (result.cancelled && !settled) finish(cancelled()); else check(); }, finish);
  void promise.catch(() => undefined);
  check();
  return { id, promise };
}

function stageBatch(request: ChapterDownloadBatchJob, runBatchId: string, persist: boolean): ChapterDownloadBatchHandle {
  let requested = [...request.jobs].map(job => pausedWorks.has(JSON.stringify([job.pluginId, job.novelId])) ? { ...job, vpnWorkPaused: true } : job);
  const requestedIds = new Set(requested.map(job => job.id));
  const duplicate = [...batches.values()].find(batch => !batch.cancelRequested && batch.jobs.length === requestedIds.size && batch.jobs.every(job => requestedIds.has(job.id)));
  if (duplicate?.handle) return duplicate.handle;
  if (persist) {
    const owned = new Set([...drafts.values()].flatMap(draft => draft.jobs.map(job => job.id)));
    for (const plan of coordinator.getPlans()) {
      for (const range of plan.ranges) if (range.phase !== "cancelled") for (const id of range.selectedChapterIds.slice(range.checkpoint)) owned.add(id);
    }
    requested = requested.filter(job => !owned.has(job.id));
    if (!requested.length) {
      const owner = [...batches.values()].find(batch => !batch.cancelRequested && [...requestedIds].every(id => batch.jobs.some(job => job.id === id)));
      if (owner?.handle) return owner.handle;
      return { id: `vpn-batch-${crypto.randomUUID()}`, materialized: Promise.resolve(), promise: Promise.resolve({ total: 0, succeeded: 0, failed: 0, cancelled: 0 }) };
    }
  }
  const id = `vpn-batch-${crypto.randomUUID()}`;
  let resolve!: PendingBatch["resolve"];
  let reject!: PendingBatch["reject"];
  const promise = new Promise<ChapterDownloadBatchResult>((done, fail) => { resolve = done; reject = fail; });
  const batch: PendingBatch = { id, total: 0, cancelled: 0, materializing: true, draftIds: new Set(), planIds: new Set(), planResults: new Map(), resolve, reject,
    runBatchId, jobs: requested, cancelRequested: false, persistence: Promise.resolve() };
  const groups = new Map<string, ChapterDownloadJob[]>();
  for (const input of requested) {
      if (!input.novelId || input.vpnPlanId || input.vpnRangeId) throw new Error("A VPN batch requires ordinary source chapter jobs with a work identity.");
      const groupKey = JSON.stringify([input.pluginId, input.novelId]);
      const group = groups.get(groupKey) ?? [];
      if (group.some(job => job.id === input.id)) throw new Error("Duplicate chapter in VPN batch.");
      group.push({ ...input }); groups.set(groupKey, group);
      batch.total++;
  }
  batches.set(id, batch);
  for (const group of groups.values()) {
    const first = group[0]!;
    const draft: PendingDraft = { work: { id: `vpn-draft-${crypto.randomUUID()}`, batchId: id, title: first.novelName ?? request.title,
      pluginId: first.pluginId, novelId: first.novelId!, chapters: [], selectedChapterIds: group.map(job => job.id), error: null,
      phase: first.vpnWorkPaused ? "paused" : "preparing", userPaused: first.vpnWorkPaused === true }, jobs: group, starting: false };
    drafts.set(draft.work.id, draft); batch.draftIds.add(draft.work.id);
  }
  publish();
  let persisted = !persist;
  const materialized = (async () => {
    if (batch.cancelRequested) return;
    batch.persistence = persist ? enqueuePendingVpnDownloadJobs(runBatchId, requested)
      : requested.some(job => job.vpnWorkPaused) ? setPendingVpnDownloadJobsPaused(runBatchId, requested.filter(job => job.vpnWorkPaused).map(job => job.id), true).then(() => undefined) : Promise.resolve();
    await batch.persistence;
    persisted = true;
    if (batch.cancelRequested || batches.get(id) !== batch) return;
    batch.materializing = false;
    await initializeVpnDownloadRuntime();
    if (batch.cancelRequested || batches.get(id) !== batch) return;
    for (const draftId of batch.draftIds) {
      const draft = drafts.get(draftId);
      if (draft) void prepareDraft(draft).catch(() => undefined);
    }
    retryPendingDrafts();
    syncBatches();
  })().catch(error => {
    if (batches.get(id) !== batch) return;
    if (!persisted) {
      for (const draftId of batch.draftIds) drafts.delete(draftId);
      batches.delete(id);
    } else {
      batch.materializing = false;
      for (const draftId of batch.draftIds) {
        const draft = drafts.get(draftId);
        if (draft) draft.work = { ...draft.work, phase: "failed", error: describeError(error) };
      }
    }
    report(error); reject(error); throw error;
  });
  void promise.catch(() => undefined); void materialized.catch(() => undefined);
  batch.handle = { id, promise, materialized };
  return batch.handle;
}

function prepareDraft(draft: PendingDraft): Promise<void> {
  draft.preparation ??= (async () => {
    const catalog = await listChaptersByNovel(draft.work.novelId);
    if (drafts.get(draft.work.id) !== draft || draft.cancelling) return;
    const selected = new Set(draft.jobs.map(job => job.id));
    const selectedChapterIds = catalog.filter(chapter => selected.has(chapter.id)).map(chapter => chapter.id);
    if (selected.size !== selectedChapterIds.length) throw new Error("A selected chapter is missing from its source work catalog.");
    draft.work = { ...draft.work, chapters: catalog.map(({ id, name, chapterNumber }) => ({ id, name, chapterNumber })), selectedChapterIds };
    publish();
  })().catch(error => {
    draft.preparation = undefined;
    if (drafts.get(draft.work.id) === draft && !draft.cancelling) {
      draft.work = { ...draft.work, phase: "failed", error: describeError(error) };
      publish();
    }
    throw error;
  });
  return draft.preparation;
}

function resetFailedDrafts(): void {
  for (const draft of drafts.values()) {
    if (draft.work.phase === "failed" && !draft.cancelling) draft.work = { ...draft.work, phase: "preparing", error: null };
  }
}

function retryPendingDrafts(): void {
  if (activeRun?.status !== "running" || deviceRestore) return;
  for (const draft of drafts.values()) {
    const batch = batches.get(draft.work.batchId);
    if (!batch || batch.materializing || batch.cancelRequested || draft.starting || draft.planId || draft.cancelling || draft.work.userPaused || draft.work.phase === "failed") continue;
    void startVpnDownloadDraft(draft.work.id).catch(error => {
      if (drafts.get(draft.work.id) !== draft) return;
      draft.work = { ...draft.work, phase: "failed", error: describeError(error) };
      publish();
    });
  }
}

function requireDraftStartSettings(rangeCount: number) {
  const settings = useVpnDownloadStore.getState();
  if (settings.mode === "off" || !snapshot.capabilities.supported || (settings.mode === "parallel" && !snapshot.capabilities.parallelSupported)) throw new Error("Automatic VPN downloads are disabled or unsupported.");
  const cap = settings.mode === "single" ? 1 : Math.min(settings.workerCount, snapshot.capabilities.maxWorkers);
  if (!rangeCount || rangeCount > cap) throw new Error("VPN range count exceeds the configured worker limit.");
  return { mode: settings.mode, captchaPolicy: settings.captchaPolicy, cloudflarePolicy: settings.cloudflarePolicy };
}

export async function startVpnDownloadDraft(draftId: string, assignments?: readonly VpnDownloadRangeAssignment[]): Promise<void> {
  await initializeVpnDownloadRuntime();
  requireNoDeviceRestore();
  const draft = drafts.get(draftId);
  if (!draft || draft.starting || draft.planId) throw new Error("VPN draft is unavailable or already starting.");
  if (draft.work.userPaused) return;
  if (assignments) requireDraftStartSettings(assignments.length);
  const stopEpoch = automaticStopEpoch;
  const eligibilityRevision = profileRevision;
  draft.starting = "profiles";
  try {
    await prepareDraft(draft);
    if (drafts.get(draftId) !== draft || draft.cancelling || draft.work.userPaused || stopEpoch !== automaticStopEpoch) return;
    const profiles = (await availableProfiles()).filter(profile => !reservedProfiles.includes(profile.id));
    if (drafts.get(draftId) !== draft || draft.cancelling || draft.work.userPaused || stopEpoch !== automaticStopEpoch || useVpnDownloadStore.getState().mode === "off") return;
    const configured = useVpnDownloadStore.getState();
    const count = Math.min(configured.mode === "single" ? 1 : configured.workerCount, snapshot.capabilities.maxWorkers, profiles.length, draft.jobs.length);
    if (!assignments && count === 0) { draft.work = { ...draft.work, phase: "waiting-profile" }; publish(); return; }
    const settings = requireDraftStartSettings(assignments?.length ?? count);
    draft.starting = "publishing";
    const occupied = new Set([...sessions.values()].map(session => session.profileId));
    for (const plan of coordinator.getPlans()) {
      for (const range of plan.ranges) if (range.phase === "connecting" || range.phase === "running") occupied.add(range.attemptProfileId ?? range.profileId);
    }
    profiles.sort((left, right) => Number(occupied.has(left.id)) - Number(occupied.has(right.id)));
    const ranges = planVpnDownloadRanges(draft.work.chapters, draft.work.selectedChapterIds, (assignments ? profiles : profiles.slice(0, count)).map(profile => profile.id), assignments);
    const id = `vpn-plan-${crypto.randomUUID()}`;
    const batch = batches.get(draft.work.batchId)!;
    const plan: VpnDownloadPlan = { id, batchId: batch.runBatchId, pluginId: draft.work.pluginId, novelId: draft.work.novelId, title: draft.work.title,
      mode: settings.mode, policies: { captcha: activeRun?.options.captchaPolicy ?? settings.captchaPolicy, cloudflare: activeRun?.options.cloudflarePolicy ?? settings.cloudflarePolicy }, createdAt: Date.now(), revision: 0,
      ranges: ranges.map((range, index) => ({ ...range, id: `${id}-${index}`, profileHash: profiles.find(profile => profile.id === range.profileId)!.hash,
        checkpoint: 0, phase: "paused", userPaused: false, pauseReason: null, attemptedProfileIds: [], attemptProfileId: null, generation: 0, challenge: null })),
    };
    const jobs = draft.jobs.map(job => ({ ...job, batchId: batch.runBatchId, vpnBatchId: batch.runBatchId, batchTitle: draft.work.title,
      vpnPlanId: id, vpnRangeId: plan.ranges.find(range => range.selectedChapterIds.includes(job.id))!.id }));
    batch.planIds.add(id);
    draft.planId = id;
    try { await coordinator.start(plan, jobs); } catch (error) {
      batch.planIds.delete(id); batch.planResults.delete(id); draft.planId = undefined; throw error;
    }
    if (draft.cancelling) { await draft.cancelling; return; }
    drafts.delete(draftId); batch.draftIds.delete(draftId);
    publish({ chapterLabels: { ...snapshot.chapterLabels, [id]: Object.fromEntries(draft.work.chapters.map(chapter => [chapter.id, chapter.name])) } });
    syncBatches();
  } finally {
    draft.starting = false;
    if (profileRevision !== eligibilityRevision && drafts.get(draftId) === draft && !draft.cancelling) queueMicrotask(retryPendingDrafts);
  }
}

export function cancelVpnDownloadDraft(draftId: string): Promise<void> {
  const draft = drafts.get(draftId);
  if (!draft) return Promise.resolve();
  if (draft.cancelling) return draft.cancelling;
  const finish = () => {
    if (drafts.get(draftId) !== draft) return;
    drafts.delete(draftId);
    const batch = batches.get(draft.work.batchId);
    if (batch) {
      if (draft.planId) { batch.planIds.delete(draft.planId); batch.planResults.delete(draft.planId); }
      batch.draftIds.delete(draftId); batch.cancelled += draft.jobs.length;
    }
    releaseFinishedWorkHold(draft.work.pluginId, draft.work.novelId);
    syncBatches();
    if (batch?.cancelRequested && !batch.cancellation) cancelBatch(batch.id);
  };
  const batch = batches.get(draft.work.batchId);
  const cancelling = (async () => {
    await batch?.persistence;
    if (draft.planId) await coordinator.cancelPlan(draft.planId);
    if (batch) await cancelPendingVpnDownloadJobs(batch.runBatchId, draft.jobs.map(job => job.id));
    finish();
  })();
  draft.cancelling = cancelling;
  void cancelling.catch(error => {
    if (draft.cancelling === cancelling) draft.cancelling = undefined;
    report(error);
  });
  return cancelling;
}

function cancelBatch(id: string): boolean {
  const observer = chapterObservers.get(id);
  if (observer) { observer(); return true; }
  const batch = batches.get(id);
  if (!batch) return false;
  if (batch.cancellation) return true;
  batch.cancelRequested = true;
  batch.materializing = true;
  batch.cancellation = (async () => {
    await batch.persistence;
    const pending = [...batch.draftIds].map(id => drafts.get(id)).filter((draft): draft is PendingDraft => Boolean(draft));
    for (const draft of pending) cancelVpnDownloadDraft(draft.work.id);
    await Promise.all(pending.map(draft => draft.cancelling));
    for (const planId of batch.planIds) await coordinator.cancelPlan(planId);
    await cancelPendingVpnDownloadJobs(batch.runBatchId, batch.jobs.map(job => job.id));
    for (const job of batch.jobs) if (job.novelId) releaseFinishedWorkHold(job.pluginId, job.novelId);
    batch.materializing = false;
    syncBatches();
  })();
  const cancellation = batch.cancellation;
  void cancellation.catch(error => {
    if (batch.cancellation === cancellation) batch.cancellation = undefined;
    report(error);
  });
  return true;
}

installChapterDownloadBatchInterceptor({ enqueue: enqueueBatch, enqueueChapter: enqueueSingleChapter, cancel: cancelBatch, isQueued: id => ownedUnfinishedChapterIds.has(id) });

export async function resumeVpnDownloadRange(planId: string, rangeId: string, restartPass = false): Promise<void> {
  await initializeVpnDownloadRuntime();
  requireNoDeviceRestore();
  if (useVpnDownloadStore.getState().mode === "off" || !snapshot.capabilities.supported) throw new Error("Automatic VPN downloads are disabled or unsupported.");
  await coordinator.resumeRange(planId, rangeId, { restartPass });
}
export async function reallowVpnDownloadBatchProfile(batchId: string, ip: string, expectedRevision: number): Promise<void> {
  await initializeVpnDownloadRuntime();
  requireNoDeviceRestore();
  await coordinator.reallowProfile(batchId, ip, expectedRevision);
}
export async function notifyVpnDownloadProfilesChanged(): Promise<void> {
  await initializeVpnDownloadRuntime();
  requireNoDeviceRestore();
  await coordinator.profilesChanged();
}
export async function pauseVpnDownloadRange(planId: string, rangeId: string): Promise<void> {
  await initializeVpnDownloadRuntime();
  activeRun?.resumeRangeIds.delete(JSON.stringify([planId, rangeId]));
  await coordinator.pauseRange(planId, rangeId);
}
export async function cancelVpnDownloadRange(planId: string, rangeId: string): Promise<void> {
  await initializeVpnDownloadRuntime();
  const plan = coordinator.getPlans().find(plan => plan.id === planId);
  await coordinator.cancelRange(planId, rangeId);
  if (plan) releaseFinishedWorkHold(plan.pluginId, plan.novelId);
}
export async function openVpnDownloadVerification(planId: string, rangeId: string): Promise<void> {
  await initializeVpnDownloadRuntime();
  if (!await coordinator.openVerification(planId, rangeId)) throw new Error("The owning VPN verification session is no longer available. Resume the range first.");
}
