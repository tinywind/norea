import { listChaptersByNovel } from "../../db/queries/chapter";
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
import { getPluginVpnStatus } from "../plugin-vpn";
import { connectPluginVpnDownloadWorker, disconnectPluginVpnDownloadWorker, getPluginVpnDownloadGenerationFloor, stopPluginVpnDownloadWorkers } from "../plugin-vpn-download-workers";
import { listSavedPluginVpnProfiles, SAVED_PLUGIN_VPN_PROFILES_CHANGED_EVENT, type SavedVpnProfile } from "../plugin-vpn-profiles";
import { isAndroidRuntime, isTauriRuntime } from "../tauri-runtime";
import { installChapterDownloadBatchInterceptor } from "./chapter-download-batch-interceptor";
import { enqueueVpnDownloadChapter, publishVpnDownloadBatchProgress, type ChapterDownloadBatchHandle, type ChapterDownloadBatchJob, type ChapterDownloadBatchResult, type ChapterDownloadJob } from "./chapter-download";
import { taskScheduler } from "./scheduler";
import { VpnDownloadCoordinator, type VpnDownloadRuntime } from "./vpn-download-coordinator";
import type { VpnDownloadDraftWork, VpnDownloadRuntimeSnapshot } from "./vpn-download-drafts";
import { planVpnDownloadRanges, type VpnDownloadRangeAssignment } from "./vpn-download-ranges";
import type { VpnDownloadPlan, VpnDownloadWorkerRef } from "./vpn-download-types";
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
}

interface PendingDraft {
  work: VpnDownloadDraftWork;
  jobs: ChapterDownloadJob[];
  starting: false | "profiles" | "publishing";
  planId?: string;
  cancelling?: Promise<void>;
}

interface WorkerSession {
  planId: string;
  worker: VpnDownloadWorkerRef;
  sourceId: string;
  browserStarted: boolean;
  unregister?: () => void;
  closing?: Promise<void>;
}

const batches = new Map<string, PendingBatch>();
const drafts = new Map<string, PendingDraft>();
const sessions = new Map<string, WorkerSession>();
const listeners = new Set<() => void>();
let reservedProfiles: string[] = [];
let automaticStopEpoch = 0;
let deviceRestore: symbol | undefined;
let initialization: Promise<void> | undefined;
let snapshot: VpnDownloadRuntimeSnapshot = {
  drafts: [], plans: [], loading: true, error: null,
  capabilities: { supported: false, parallelSupported: false, maxWorkers: 0 }, chapterLabels: {},
};

function publish(update: Partial<VpnDownloadRuntimeSnapshot> = {}): void {
  snapshot = { ...snapshot, ...update, drafts: [...drafts.values()].map(draft => draft.work), plans: coordinator.getPlans() };
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
    syncBatches();
  });
  const closing = session.closing;
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
    const session: WorkerSession = { planId: plan.id, worker, sourceId: plan.pluginId, browserStarted: false };
    sessions.set(vpnDownloadExecutor(worker), session);
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
}
coordinator.subscribe(syncBatches);

function capabilities(): VpnDownloadRuntimeSnapshot["capabilities"] {
  const unsupported = { supported: false, parallelSupported: false, maxWorkers: 0 };
  if (!isAndroidRuntime()) return unsupported;
  try {
    const value: unknown = JSON.parse(window.__NoreaAndroidVpnWorkers?.capabilities() ?? "null");
    if (!value || typeof value !== "object" || !("supported" in value) || value.supported !== true ||
      !("maxWorkers" in value) || value.maxWorkers !== 2 || !("parallelSupported" in value) || value.parallelSupported !== true) return unsupported;
    return { supported: true, parallelSupported: true, maxWorkers: 2 };
  } catch { return unsupported; }
}

export function initializeVpnDownloadRuntime(): Promise<void> {
  initialization ??= (async () => {
    publish({ capabilities: capabilities() });
    const settings = useVpnDownloadStore.getState();
    coordinator.setWorkerLimit(settings.mode === "single" || settings.workerCount === 1 ? 1 : 2);
    if (!isTauriRuntime()) { publish({ loading: false }); return; }
    await coordinator.restore();
    const labels: Record<string, Record<number, string>> = {};
    for (const plan of coordinator.getPlans()) {
      const catalog = await listChaptersByNovel(plan.novelId);
      labels[plan.id] = Object.fromEntries(catalog.map(chapter => [chapter.id, chapter.name]));
    }
    publish({ loading: false, chapterLabels: labels });
    const seen = new Set<string>();
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
      coordinator.setWorkerLimit(next.mode === "single" || next.workerCount === 1 ? 1 : 2);
      if (next.mode === "off" && previous.mode !== "off") {
        automaticStopEpoch++;
        void coordinator.stopAutomatic().catch(report);
      }
    });
    window.addEventListener(SAVED_PLUGIN_VPN_PROFILES_CHANGED_EVENT, () => {
      if (!deviceRestore) void coordinator.profilesChanged().catch(report);
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

export async function suspendVpnDownloadsForRestore(): Promise<() => void> {
  requireNoDeviceRestore();
  const hold = Symbol();
  deviceRestore = hold;
  automaticStopEpoch++;
  const release = () => { if (deviceRestore === hold) deviceRestore = undefined; };
  try {
    await initializeVpnDownloadRuntime();
    await coordinator.stopForRestore();
    await Promise.all([...sessions.values()].map(session => disconnectWorker(session.worker)));
    await stopPluginVpnDownloadWorkers();
    return release;
  } catch (error) { release(); throw error; }
}

function enqueueBatch(request: ChapterDownloadBatchJob): ChapterDownloadBatchHandle | null {
  requireNoDeviceRestore();
  if (useVpnDownloadStore.getState().mode === "off" || request.persist === false) return null;
  const id = `vpn-batch-${crypto.randomUUID()}`;
  let resolve!: PendingBatch["resolve"];
  let reject!: PendingBatch["reject"];
  const promise = new Promise<ChapterDownloadBatchResult>((done, fail) => { resolve = done; reject = fail; });
  const batch: PendingBatch = { id, total: 0, cancelled: 0, materializing: true, draftIds: new Set(), planIds: new Set(), planResults: new Map(), resolve, reject };
  batches.set(id, batch);
  const materialized = (async () => {
    const groups = new Map<string, ChapterDownloadJob[]>();
    for (const input of request.jobs) {
      if (!input.novelId || input.vpnPlanId || input.vpnRangeId) throw new Error("A VPN batch requires ordinary source chapter jobs with a work identity.");
      const groupKey = JSON.stringify([input.pluginId, input.novelId]);
      const group = groups.get(groupKey) ?? [];
      if (group.some(job => job.id === input.id)) throw new Error("Duplicate chapter in VPN batch.");
      group.push({ ...input }); groups.set(groupKey, group);
      batch.total++;
    }
    await initializeVpnDownloadRuntime();
    if (batches.get(id) !== batch) return;
    if (!snapshot.capabilities.supported) throw new Error("Isolated VPN downloads are not supported on this device.");
    const prepared: PendingDraft[] = [];
    for (const group of groups.values()) {
      const first = group[0]!;
      const catalog = await listChaptersByNovel(first.novelId!);
      if (batches.get(id) !== batch) return;
      const chapters = catalog.map(({ id, name, chapterNumber }) => ({ id, name, chapterNumber }));
      const selected = new Set(group.map(job => job.id));
      const selectedChapterIds = chapters.filter(chapter => selected.has(chapter.id)).map(chapter => chapter.id);
      if (selectedChapterIds.length !== selected.size) throw new Error("A selected chapter is missing from its source work catalog.");
      prepared.push({ work: { id: `vpn-draft-${crypto.randomUUID()}`, batchId: id, title: first.novelName ?? request.title,
        pluginId: first.pluginId, novelId: first.novelId!, chapters, selectedChapterIds, error: null }, jobs: group, starting: false });
    }
    if (batches.get(id) !== batch) return;
    batch.total = prepared.reduce((count, draft) => count + draft.jobs.length, 0);
    batch.materializing = false;
    for (const draft of prepared) { drafts.set(draft.work.id, draft); batch.draftIds.add(draft.work.id); }
    publish(); syncBatches();
  })().catch(error => {
    if (batches.get(id) !== batch) return;
    batches.delete(id); report(error); reject(error); throw error;
  });
  void promise.catch(() => undefined); void materialized.catch(() => undefined);
  return { id, promise, materialized };
}

function requireDraftStartSettings(rangeCount: number) {
  const settings = useVpnDownloadStore.getState();
  if (settings.mode === "off" || !snapshot.capabilities.supported || (settings.mode === "parallel" && !snapshot.capabilities.parallelSupported)) throw new Error("Automatic VPN downloads are disabled or unsupported.");
  const cap = settings.mode === "single" ? 1 : Math.min(settings.workerCount, snapshot.capabilities.maxWorkers);
  if (!rangeCount || rangeCount > cap) throw new Error("VPN range count exceeds the configured worker limit.");
  return { mode: settings.mode, captchaPolicy: settings.captchaPolicy, cloudflarePolicy: settings.cloudflarePolicy };
}

export async function startVpnDownloadDraft(draftId: string, assignments: readonly VpnDownloadRangeAssignment[]): Promise<void> {
  await initializeVpnDownloadRuntime();
  requireNoDeviceRestore();
  const draft = drafts.get(draftId);
  if (!draft || draft.starting || draft.planId) throw new Error("VPN draft is unavailable or already starting.");
  requireDraftStartSettings(assignments.length);
  const stopEpoch = automaticStopEpoch;
  draft.starting = "profiles";
  try {
    const profiles = (await availableProfiles()).filter(profile => !reservedProfiles.includes(profile.id));
    if (drafts.get(draftId) !== draft || stopEpoch !== automaticStopEpoch || useVpnDownloadStore.getState().mode === "off") return;
    const settings = requireDraftStartSettings(assignments.length);
    draft.starting = "publishing";
    const ranges = planVpnDownloadRanges(draft.work.chapters, draft.work.selectedChapterIds, profiles.map(profile => profile.id), assignments);
    const id = `vpn-plan-${crypto.randomUUID()}`;
    const plan: VpnDownloadPlan = { id, batchId: draft.work.batchId, pluginId: draft.work.pluginId, novelId: draft.work.novelId, title: draft.work.title,
      mode: settings.mode, policies: { captcha: settings.captchaPolicy, cloudflare: settings.cloudflarePolicy }, createdAt: Date.now(), revision: 0,
      ranges: ranges.map((range, index) => ({ ...range, id: `${id}-${index}`, profileHash: profiles.find(profile => profile.id === range.profileId)!.hash,
        checkpoint: 0, phase: "paused", userPaused: false, pauseReason: null, attemptedProfileIds: [], attemptProfileId: null, generation: 0, challenge: null })),
    };
    const jobs = draft.jobs.map(job => ({ ...job, batchId: draft.work.batchId, batchTitle: draft.work.title,
      vpnPlanId: id, vpnRangeId: plan.ranges.find(range => range.selectedChapterIds.includes(job.id))!.id }));
    const batch = batches.get(draft.work.batchId)!;
    batch.planIds.add(id);
    draft.planId = id;
    try { await coordinator.start(plan, jobs); } catch (error) {
      batch.planIds.delete(id); batch.planResults.delete(id); draft.planId = undefined; throw error;
    }
    if (draft.cancelling) { await draft.cancelling; return; }
    drafts.delete(draftId); batch.draftIds.delete(draftId);
    publish({ chapterLabels: { ...snapshot.chapterLabels, [id]: Object.fromEntries(draft.work.chapters.map(chapter => [chapter.id, chapter.name])) } });
    syncBatches();
  } finally { draft.starting = false; }
}

export function cancelVpnDownloadDraft(draftId: string): void {
  const draft = drafts.get(draftId);
  if (!draft || draft.cancelling) return;
  const finish = () => {
    if (drafts.get(draftId) !== draft) return;
    drafts.delete(draftId);
    const batch = batches.get(draft.work.batchId);
    if (batch) {
      if (draft.planId) { batch.planIds.delete(draft.planId); batch.planResults.delete(draft.planId); }
      batch.draftIds.delete(draftId); batch.cancelled += draft.jobs.length;
    }
    syncBatches();
  };
  if (!draft.planId) { finish(); return; }
  const cancelling = coordinator.cancelPlan(draft.planId).then(finish);
  draft.cancelling = cancelling;
  void cancelling.catch(error => {
    if (draft.cancelling === cancelling) draft.cancelling = undefined;
    report(error);
  });
}

installChapterDownloadBatchInterceptor({ enqueue: enqueueBatch, cancel: id => {
  const batch = batches.get(id);
  if (!batch) return false;
  if (batch.materializing) {
    batches.delete(id);
    batch.resolve({ total: batch.total, succeeded: 0, failed: 0, cancelled: batch.total });
    return true;
  }
  for (const draftId of [...batch.draftIds]) cancelVpnDownloadDraft(draftId);
  for (const planId of batch.planIds) void coordinator.cancelPlan(planId).catch(report);
  return true;
} });

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
export async function pauseVpnDownloadRange(planId: string, rangeId: string): Promise<void> { await initializeVpnDownloadRuntime(); await coordinator.pauseRange(planId, rangeId); }
export async function cancelVpnDownloadRange(planId: string, rangeId: string): Promise<void> { await initializeVpnDownloadRuntime(); await coordinator.cancelRange(planId, rangeId); }
export async function openVpnDownloadVerification(planId: string, rangeId: string): Promise<void> {
  await initializeVpnDownloadRuntime();
  if (!await coordinator.openVerification(planId, rangeId)) throw new Error("The owning VPN verification session is no longer available. Resume the range first.");
}
