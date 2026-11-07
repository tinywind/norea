import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterDownloadBatchResult, ChapterDownloadJob } from "./chapter-download";
import type { VpnDownloadPlan, VpnDownloadProfileIssue, VpnDownloadProfileIssueInput, VpnDownloadWorkerRef } from "./vpn-download-types";
import type { SourceAccessBlock } from "./source-access-gate";
import { sourceAccessScopeKey } from "../plugins/source-access";

const boundary = vi.hoisted(() => ({
  plans: new Map<string, VpnDownloadPlan>(), jobs: [] as ChapterDownloadJob[],
  issues: [] as VpnDownloadProfileIssue[],
  blocks: [] as SourceAccessBlock[], listeners: new Set<() => void>(),
  effects: [] as string[], complete: new Map<number, () => void>(), reject: new Map<number, (error: Error) => void>(),
  invoke: vi.fn(), catalog: vi.fn(), enqueue: vi.fn(), configure: vi.fn(), close: vi.fn(), show: vi.fn(),
  profiles: vi.fn(), status: vi.fn(), recoveryStopped: vi.fn(() => false), connect: vi.fn(), disconnect: vi.fn(),
  stop: vi.fn(), restart: vi.fn(), createPlan: vi.fn(), cancelPlan: vi.fn(), cancelTask: vi.fn(),
  settleTask: vi.fn(), restoreEffects: [] as string[],
  pendingJobs: new Map<number, ChapterDownloadJob>(), handover: vi.fn(), persistPending: vi.fn(), cancelOrdinary: vi.fn(), discardOrdinary: vi.fn(),
  requestEnqueue: vi.fn(), automatic: vi.fn(), finder: vi.fn(), testCandidate: vi.fn(), recordResult: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke }));
vi.mock("../../db/client", () => ({
  getDb: async () => { boundary.restoreEffects.push("database-open"); return {}; },
  cancelWorkMetadataRecovery: () => { boundary.restoreEffects.push("metadata-stop"); },
  runExclusiveDatabaseOperation: async (run: () => Promise<unknown>) => { boundary.restoreEffects.push("database-lock"); return run(); },
}));
vi.mock("../../i18n", () => ({ translate: (_locale: string, key: string) => key }));
vi.mock("../../store/appearance", () => ({ useAppearanceStore: { getState: () => ({ appLocale: "en" }) } }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => ({ serverUrl: "http://backup.test", deviceName: "Tablet" }) } }));
vi.mock("../content-sync/client", () => ({
  normalizeContentServerUrl: (url: string) => url,
  contentServerRequest: async () => ({ apiVersion: 1, packageVersion: 1, authentication: "device-key", deviceBackupVersion: 1 }),
}));
vi.mock("../content-sync/device", () => ({ registerContentDevice: async () => "device-token" }));
vi.mock("../content-sync/sync", () => ({
  runContentSyncOperation: async (run: () => Promise<unknown>) => { boundary.restoreEffects.push("sync-lock"); return run(); },
}));
vi.mock("../content-sync/storage-operation", () => ({
  runContentStorageOperation: async (run: () => Promise<unknown>) => { boundary.restoreEffects.push("storage-lock"); return run(); },
}));
vi.mock("./main-tasks", () => ({ enqueueMainTask: ({ run }: { run: () => Promise<unknown> }) => ({ promise: run() }) }));
// Real chunks hold 50 chapters; two-chapter chunks keep multi-range behavior observable in these few-chapter works.
vi.mock("./vpn-download-ranges", async importOriginal => ({
  ...await importOriginal<typeof import("./vpn-download-ranges")>(),
  vpnDownloadChunkCount: (count: number) => Math.max(1, Math.ceil(count / 2)),
}));
vi.mock("../../db/queries/chapter", () => ({ listChaptersByNovel: boundary.catalog }));
vi.mock("../../db/queries/chapter-download-failure", () => ({ getChapterDownloadFailure: vi.fn(async () => undefined) }));
vi.mock("../plugins/manager", () => ({ pluginManager: { releaseExecutorRuntimes: vi.fn() } }));
vi.mock("../../db/queries/chapter-download-queue", () => ({
  listPendingVpnDownloadJobs: async () => [...boundary.pendingJobs.values()].map(job => ({ job: structuredClone(job), jobJson: JSON.stringify(job), updatedAtMs: 1 })),
  enqueuePendingVpnDownloadJobs: boundary.persistPending,
  cancelPendingVpnDownloadBatch: async (batchId: string) => {
    let count = 0;
    for (const [id, job] of boundary.pendingJobs) if (job.vpnBatchId === batchId) { boundary.pendingJobs.delete(id); count++; }
    return count;
  },
  cancelPendingVpnDownloadJobs: async (batchId: string, ids: readonly number[]) => {
    let count = 0;
    for (const id of ids) if (boundary.pendingJobs.get(id)?.vpnBatchId === batchId) { boundary.pendingJobs.delete(id); count++; }
    return count;
  },
  setPendingVpnDownloadJobsPaused: async (batchId: string, ids: readonly number[], paused: boolean) => {
    let count = 0;
    for (const id of ids) {
      const stored = boundary.pendingJobs.get(id);
      if (!stored || stored.vpnBatchId !== batchId) continue;
      const next = { ...stored, vpnWorkPaused: paused || undefined };
      boundary.pendingJobs.set(id, next); count++;
    }
    return count;
  },
}));
vi.mock("../../db/queries/vpn-download-plans", () => ({
  listVpnDownloadPlans: async () => [...boundary.plans.values()],
  createVpnDownloadPlan: boundary.createPlan,
  updateVpnDownloadPlan: async (plan: VpnDownloadPlan, revision: number) => {
    if (boundary.plans.get(plan.id)?.revision !== revision) throw new Error("Stale revision");
    const next = { ...structuredClone(plan), revision: revision + 1 };
    boundary.plans.set(next.id, next); return next;
  },
  restartVpnDownloadProfilePass: boundary.restart,
  getVpnDownloadRangeJobs: async (planId: string, rangeId: string) => boundary.jobs.filter(job => job.vpnPlanId === planId && job.vpnRangeId === rangeId),
  settleVpnDownloadChapter: async (planId: string, rangeId: string, chapterId: number, generation: number) => {
    const plan = structuredClone(boundary.plans.get(planId)!);
    const range = plan.ranges.find(range => range.id === rangeId)!;
    if (range.generation !== generation || range.selectedChapterIds[range.checkpoint] !== chapterId) throw new Error("Stale settlement");
    range.checkpoint++; range.challenge = null; range.attemptedProfileIds = []; range.attemptProfileId = null;
    if (range.checkpoint === range.selectedChapterIds.length) range.phase = "completed";
    boundary.jobs = boundary.jobs.filter(job => job.id !== chapterId);
    plan.revision++; boundary.effects.push(`settle:${chapterId}`); boundary.plans.set(planId, plan); return plan;
  },
  cancelVpnDownloadRange: async (planId: string, rangeId: string) => {
    const plan = structuredClone(boundary.plans.get(planId)!);
    plan.ranges.find(range => range.id === rangeId)!.phase = "cancelled"; plan.revision++;
    boundary.plans.set(planId, plan); return plan;
  },
  cancelVpnDownloadPlan: boundary.cancelPlan,
}));
vi.mock("../../db/queries/vpn-download-profile-issues", () => ({
  listVpnDownloadProfileIssues: async (batchId?: string) => structuredClone(boundary.issues.filter(issue => batchId === undefined || issue.batchId === batchId)),
  recordVpnDownloadProfileIssue: async (input: VpnDownloadProfileIssueInput) => {
    const issue = { ...input, recordedAt: 1, excluded: true, revision: 1 }; boundary.issues.push(issue); return structuredClone(issue);
  },
  reallowVpnDownloadProfile: async (batchId: string, ip: string, revision: number) => {
    const issue = boundary.issues.find(issue => issue.batchId === batchId && issue.ip === ip);
    if (!issue?.excluded || issue.revision !== revision) throw new Error("Stale issue revision");
    issue.excluded = false; issue.revision++; return structuredClone(issue);
  },
}));
vi.mock("../plugin-vpn-profiles", () => ({ SAVED_PLUGIN_VPN_PROFILES_CHANGED_EVENT: "norea-vpn-profiles-changed", listSavedPluginVpnProfiles: boundary.profiles }));
vi.mock("../plugin-vpn-automatic", () => ({
  listAutomaticPluginVpnProfiles: boundary.automatic, testAutomaticPluginVpnCandidate: boundary.testCandidate,
  recordAutomaticPluginVpnProfileResult: boundary.recordResult,
}));
vi.mock("../plugin-vpn", () => ({
  getPluginVpnStatus: boundary.status, isPluginVpnRecoveryStopped: boundary.recoveryStopped, loadPluginVpnFinderServers: boundary.finder,
  PLUGIN_VPN_PROFILE_RELEASED_EVENT: "norea-plugin-vpn-profile-released",
}));
vi.mock("../plugin-vpn-download-workers", () => ({
  getPluginVpnDownloadGenerationFloor: async () => 0,
  connectPluginVpnDownloadWorker: boundary.connect, disconnectPluginVpnDownloadWorker: boundary.disconnect,
  stopPluginVpnDownloadWorkers: boundary.stop,
}));
vi.mock("../android-scraper", () => ({
  androidConfigureVpnDownloadWorker: boundary.configure, androidCloseVpnDownloadWorker: boundary.close,
  androidShowVpnDownloadWorker: boundary.show,
}));
vi.mock("../tauri-runtime", () => ({ isAndroidRuntime: () => true, isTauriRuntime: () => true }));
vi.mock("./chapter-download", () => ({
  releaseVpnDownloadPlanLocalWorkScans: vi.fn(),
  enqueueChapterDownloadBatch: boundary.requestEnqueue,
  cancelChapterDownloadBatches: vi.fn(),
  enqueueVpnDownloadChapter: boundary.enqueue,
  publishVpnDownloadBatchProgress: vi.fn(),
  beginChapterDownloadVpnHandover: boundary.handover,
  cancelChapterDownloadTasks: boundary.cancelOrdinary,
  discardQueuedChapterDownloads: boundary.discardOrdinary,
}));
vi.mock("./scheduler", () => ({
  taskScheduler: {
    subscribe: (listener: () => void) => { boundary.listeners.add(listener); return () => boundary.listeners.delete(listener); },
    getSnapshot: () => ({ sourceAccessBlocks: boundary.blocks }),
    batch: (run: () => unknown) => run(),
    cancelSourceAccessBlock: (scopeKey: string, revision: number) => {
      const block = boundary.blocks.find(block => block.scopeKey === scopeKey && block.revision === revision);
      if (!block) return false;
      boundary.cancelTask(block.verificationTaskId ?? block.originTaskId);
      boundary.blocks = boundary.blocks.filter(candidate => candidate !== block);
      boundary.effects.push(`force-stop:${scopeKey}`); return true;
    },
    cancel: boundary.cancelTask, waitForSourceTaskSettlement: boundary.settleTask,
    beginVpnSourceAccessVerification: () => true,
  },
}));

let useVpnDownloadStore: typeof import("../../store/vpn-download").useVpnDownloadStore;
let interceptChapterDownloadBatch: typeof import("./chapter-download-batch-interceptor").interceptChapterDownloadBatch;

const profiles = [
  { id: "profile-a", hash: "hash-a", ip: "192.0.2.1", protocol: "tcp", approvedAt: 1, approvalSequence: 1 },
  { id: "profile-b", hash: "hash-b", ip: "192.0.2.2", protocol: "udp", approvedAt: 2, approvalSequence: 2 },
];
const jobs: ChapterDownloadJob[] = [8, 2, 9, 3].map((id) => ({
  id, pluginId: "source-test", novelId: 10, novelName: "Work", chapterPath: `/chapter/${id}`, title: `Chapter ${id}`,
}));
const catalog = [8, 2, 9, 3].map(id => ({ id, name: `Title ${id}`, chapterNumber: `${id}` }));
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const backupEntry = { deviceName: "Tablet", updatedAt: 1, size: 2048, sha256: "a".repeat(64) };
const backupFile = { path: "/cache/device-backup.zip", size: 2048, sha256: "a".repeat(64) };
const backupManifest = {
  format: "norea-device-backup", version: 2, deviceName: "Tablet", createdAt: 1, storageRoot: null,
  settings: [{ key: "restored-setting", value: "snapshot" }],
  vpnVault: { index: { path: "saved-profiles/index.json", size: 90, sha256: "b".repeat(64) }, profiles: [] },
};
function installBackupFixture(): void {
  boundary.invoke.mockReset().mockImplementation(async command => {
    if (command === "device_backup_download") return backupFile;
    if (command === "device_backup_inspect") return backupManifest;
    if (command === "device_backup_restore") { boundary.restoreEffects.push("native-restore"); return { id: "c".repeat(64), settings: backupManifest.settings }; }
    if (command === "device_backup_restore_complete") return;
    if (command === "device_backup_cleanup") return;
    throw new Error(`Unexpected backup command: ${command}`);
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules(); vi.clearAllMocks(); boundary.plans.clear(); boundary.jobs = []; boundary.effects = []; boundary.complete.clear(); boundary.reject.clear();
  boundary.restoreEffects = []; boundary.issues = []; boundary.blocks = []; boundary.listeners.clear();
  boundary.pendingJobs.clear();
  boundary.recoveryStopped.mockReset().mockReturnValue(false);
  boundary.handover.mockReset().mockResolvedValue({ jobs: [], pending: [], commitReady: async () => [], release: vi.fn() });
  boundary.cancelOrdinary.mockReset().mockResolvedValue(undefined);
  boundary.discardOrdinary.mockReset();
  boundary.persistPending.mockReset().mockImplementation(async (batchId: string, jobs: readonly ChapterDownloadJob[]) => {
    for (const job of jobs) {
      const existing = boundary.pendingJobs.get(job.id);
      if (existing && existing.vpnBatchId !== batchId) throw new Error("Another pending owner");
      boundary.pendingJobs.set(job.id, { ...job, vpnBatchId: batchId });
    }
    boundary.effects.push("persist-pending");
  });
  const settings = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return settings.size; }, key: (index: number) => [...settings.keys()][index] ?? null,
    getItem: (key: string) => settings.get(key) ?? null, setItem: (key: string, value: string) => { settings.set(key, value); },
    removeItem: (key: string) => { settings.delete(key); }, clear: () => { settings.clear(); },
  });
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => { session.set(key, value); },
    removeItem: (key: string) => { session.delete(key); },
  });
  vi.stubGlobal("window", new EventTarget());
  Object.assign(window, { localStorage });
  ({ useVpnDownloadStore } = await import("../../store/vpn-download"));
  ({ interceptChapterDownloadBatch } = await import("./chapter-download-batch-interceptor"));
  boundary.requestEnqueue.mockReset().mockImplementation((request: Parameters<typeof interceptChapterDownloadBatch>[0]) => interceptChapterDownloadBatch(request));
  Object.assign(window, { __NoreaAndroidVpnWorkers: { capabilities: () => JSON.stringify({ supported: true, parallelSupported: true, maxWorkers: 2 }) } });
  boundary.catalog.mockResolvedValue(catalog);
  boundary.createPlan.mockImplementation(async (plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]) => {
    boundary.effects.push("publish"); boundary.plans.set(plan.id, structuredClone(plan)); boundary.jobs.push(...jobs);
    for (const job of jobs) boundary.pendingJobs.delete(job.id);
  });
  boundary.cancelPlan.mockImplementation(async (id: string) => {
    boundary.plans.delete(id); boundary.jobs = boundary.jobs.filter(job => job.vpnPlanId !== id);
  });
  boundary.profiles.mockResolvedValue({ limit: 20, profiles, cleanupError: null });
  boundary.automatic.mockReset().mockResolvedValue([]);
  boundary.finder.mockReset().mockResolvedValue([]);
  boundary.testCandidate.mockReset().mockResolvedValue(false);
  boundary.recordResult.mockReset().mockResolvedValue(undefined);
  boundary.status.mockResolvedValue({ phase: "disabled", profile: null, supported: true, proxyPort: 123, error: null });
  boundary.connect.mockImplementation(async (worker, profile) => {
    boundary.effects.push(`connect:${worker.slot}`);
    return { supported: true, worker, phase: "connected", profile: profiles.find(p => p.id === profile.id), proxyPort: 12000 + worker.slot, error: null };
  });
  boundary.configure.mockImplementation(async worker => { boundary.effects.push(`configure:${worker.slot}`); });
  boundary.close.mockReset().mockResolvedValue(undefined); boundary.show.mockResolvedValue(undefined); boundary.disconnect.mockReset().mockResolvedValue({ phase: "disabled" });
  boundary.settleTask.mockReset().mockResolvedValue(undefined); boundary.stop.mockReset().mockResolvedValue(undefined);
  boundary.enqueue.mockImplementation((job, worker) => {
    boundary.effects.push(`chapter:${job.id}:${worker.slot}`);
    return { id: `task:${job.id}`, promise: new Promise<void>((resolve, reject) => {
      boundary.complete.set(job.id, resolve); boundary.reject.set(job.id, reject);
    }) };
  });
  boundary.cancelTask.mockImplementation((id: string) => {
    boundary.reject.get(Number(id.slice("task:".length)))?.(new DOMException("Task cancelled", "AbortError"));
    return true;
  });
  useVpnDownloadStore.setState({ mode: "parallel", workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "pause" });
});

describe("automatic VPN run admission", () => {
  const options = { workerCount: 2, captchaPolicy: "nextProfile" as const, cloudflarePolicy: "nextProfile" as const };

  it("fences new ordinary chapter starts synchronously before runtime initialization can yield", async () => {
    const runtime = await import("./vpn-download-runtime");
    const started = runtime.startVpnDownloadRun(options);
    try { expect(boundary.handover).toHaveBeenCalledOnce(); }
    finally { await started; await runtime.cancelVpnDownloadRun(); }
  });

  it("keeps requests ordinary until the user launches a run even when old VPN settings are enabled", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.initializeVpnDownloadRuntime();
    expect(interceptChapterDownloadBatch({ jobs, title: "Ordinary request" })).toBeNull();
    expect(boundary.catalog).not.toHaveBeenCalled();
    expect(boundary.pendingJobs.size).toBe(0);
  });

  it("admits a new direct chapter during a run and preserves its interactive priority", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const interceptor = await import("./chapter-download-batch-interceptor");
    const handle = interceptor.interceptChapterDownload({ ...jobs[0]!, priority: "interactive" })!;
    try {
      expect(handle).not.toBeNull();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
      expect(boundary.enqueue.mock.calls[0]![0]).toMatchObject({ id: 8, priority: "interactive", vpnBatchId: runtime.getVpnDownloadRuntimeSnapshot().run!.id });
      boundary.complete.get(8)!(); await handle.promise;
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("settles a direct observer at its chapter checkpoint and cancels another observer without cancelling shared work", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun({ ...options, workerCount: 1 });
    const batch = interceptChapterDownloadBatch({ jobs: jobs.slice(0, 2), title: "Shared work" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    const interceptor = await import("./chapter-download-batch-interceptor");
    const first = interceptor.interceptChapterDownload({ ...jobs[0]!, priority: "interactive" })!;
    const second = interceptor.interceptChapterDownload(jobs[1]!)!;
    try {
      const cancelled = expect(second.promise).rejects.toMatchObject({ name: "AbortError" });
      expect(interceptor.cancelInterceptedChapterDownloadBatch(second.id)).toBe(true);
      await cancelled;
      boundary.complete.get(8)!(); await first.promise;
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]!.phase).toBe("running");
      boundary.complete.get(2)!();
      await expect(batch.promise).resolves.toMatchObject({ succeeded: 2, cancelled: 0 });
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("adopts the ready ordinary queue and starts automatically without profile or range inputs", async () => {
    let committed = false;
    boundary.handover.mockResolvedValue({ jobs: [{ job: jobs[0], jobJson: JSON.stringify(jobs[0]), updatedAtMs: 1 }], pending: [],
      commitReady: async (batchId: string) => {
        if (committed) return [];
        committed = true;
        const adopted = { ...jobs[0]!, vpnBatchId: batchId }; boundary.pendingJobs.set(adopted.id, adopted); return [adopted];
      }, release: vi.fn() });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    expect(boundary.enqueue.mock.calls[0]![0]).toMatchObject({ id: 8, vpnBatchId: expect.any(String), vpnPlanId: expect.any(String), vpnRangeId: expect.any(String) });
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
    await runtime.cancelVpnDownloadRun();
  });

  it("persists a new request before a held catalog and lets another work proceed independently", async () => {
    let release!: (value: typeof catalog) => void;
    const held = new Promise<typeof catalog>(resolve => { release = resolve; });
    boundary.catalog.mockImplementation(async (novelId: number) => novelId === 10 ? held : [{ id: 20, name: "Other chapter", chapterNumber: "1" }]);
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const first = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Held work" })!;
    const second = interceptChapterDownloadBatch({ jobs: [{ ...jobs[0]!, id: 20, novelId: 20, chapterPath: "/chapter/20" }], title: "Ready work" })!;
    try {
      await vi.waitFor(() => expect(boundary.pendingJobs.has(8)).toBe(true));
      expect(runtime.getVpnDownloadRuntimeSnapshot().drafts.some(work => work.novelId === 10)).toBe(true);
      await vi.waitFor(() => expect(boundary.enqueue.mock.calls.some(([job]) => job.id === 20)).toBe(true));
      expect(boundary.effects.indexOf("persist-pending")).toBeLessThan(boundary.effects.indexOf("publish"));
      release(catalog);
      await Promise.all([first.materialized, second.materialized]);
      await vi.waitFor(() => expect(boundary.enqueue.mock.calls.some(([job]) => job.id === 8)).toBe(true));
      expect(new Set(runtime.getVpnDownloadRuntimeSnapshot().plans.map(plan => plan.batchId)).size).toBe(1);
    } finally { release(catalog); await runtime.cancelVpnDownloadRun(); }
  });

  it("leases tested servers by default, discovering them through the Finder when no profile is eligible", async () => {
    const tested = { id: "f".repeat(64), ip: "203.0.113.7", protocol: "tcp" as const, hash: "f".repeat(64), score: 9, testedAt: 1, failures: 0 };
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [profiles[0]!], cleanupError: null });
    boundary.finder.mockResolvedValue([{ candidateId: "candidate-7", ip: tested.ip, score: 9 }, { candidateId: "known", ip: profiles[0]!.ip, score: 99 }]);
    boundary.testCandidate.mockImplementation(async () => { boundary.automatic.mockResolvedValue([tested]); return true; });
    boundary.connect.mockImplementation(async (worker, profile) => {
      if (profile.id === profiles[0]!.id) throw Object.assign(new Error("Tunnel refused"), { code: "plugin-vpn-unavailable" });
      return { supported: true, worker, phase: "connected", profile, proxyPort: 12000 + worker.slot, error: null };
    });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Discover a server" })!;
    await batch.materialized;
    try {
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
      expect(boundary.finder).toHaveBeenCalledWith(true);
      expect(boundary.testCandidate).toHaveBeenCalledExactlyOnceWith("candidate-7", expect.any(AbortSignal));
      expect(boundary.connect).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: tested.id, hash: tested.hash }));
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]).toMatchObject({ profileId: tested.id, phase: "running" });
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("rejects Pause when a cancelled automatic probe cannot confirm native cleanup", async () => {
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [], cleanupError: null });
    boundary.finder.mockResolvedValue([{ candidateId: "cancelled-probe", ip: "203.0.113.7", score: 9 }]);
    let rejectProbe!: (error: Error) => void;
    boundary.testCandidate.mockImplementation(() => new Promise<boolean>((_resolve, reject) => { rejectProbe = reject; }));
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Discover a server" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.testCandidate).toHaveBeenCalledOnce());
    try {
      const pause = runtime.pauseVpnDownloadRun();
      const rejection = expect(pause).rejects.toThrow("native probe cleanup failed");
      await vi.waitFor(() => expect((boundary.testCandidate.mock.calls[0]![1] as AbortSignal).aborted).toBe(true));
      rejectProbe(new Error("native probe cleanup failed"));
      await rejection;
    } finally {
      await runtime.cancelVpnDownloadRun();
    }
  });

  it("uses only approved profiles and never discovers servers when tested servers are turned off", async () => {
    useVpnDownloadStore.getState().setUseTestedServers(false);
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [], cleanupError: null });
    boundary.automatic.mockResolvedValue([{ id: "f".repeat(64), ip: "203.0.113.7", protocol: "tcp", hash: "f".repeat(64), score: 9, testedAt: 1, failures: 0 }]);
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Approved only" })!;
    await batch.materialized;
    try {
      await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]?.ranges[0]?.pauseReason).toBe("profiles-exhausted"));
      expect(boundary.automatic).not.toHaveBeenCalled();
      expect(boundary.finder).not.toHaveBeenCalled();
      expect(boundary.connect).not.toHaveBeenCalled();
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("waits for approved profiles without losing pending intent or requiring another per-work start", async () => {
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [], cleanupError: null });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Wait for a profile" })!;
    await batch.materialized;
    expect(boundary.pendingJobs.has(8)).toBe(true);
    expect(boundary.connect).not.toHaveBeenCalled();
    boundary.profiles.mockResolvedValue({ limit: 20, profiles, cleanupError: null });
    window.dispatchEvent(new Event("norea-vpn-profiles-changed"));
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    await runtime.cancelVpnDownloadRun();
  });

  it("wakes a waiting range when the foreground VPN releases its only approved profile without changing the vault", async () => {
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [profiles[0]!], cleanupError: null });
    boundary.status.mockResolvedValue({ phase: "connected", profile: { hash: profiles[0]!.hash, remoteHost: profiles[0]!.ip }, supported: true, proxyPort: 123, error: null });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun({ ...options, workerCount: 1 });
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Occupied foreground profile" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]?.ranges[0]).toMatchObject({ phase: "paused", pauseReason: null, profileId: null }));
    expect(boundary.connect).not.toHaveBeenCalled();
    boundary.status.mockResolvedValue({ phase: "connected", profile: { hash: "different-profile", remoteHost: "192.0.2.99" }, supported: true, proxyPort: 123, error: null });
    window.dispatchEvent(new Event("norea-plugin-vpn-profile-released"));
    try { await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce()); }
    finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("cancels a held preparation without enrolling its late catalog or cancelling another work", async () => {
    let release!: (value: typeof catalog) => void;
    const held = new Promise<typeof catalog>(resolve => { release = resolve; });
    boundary.catalog.mockImplementation(async (id: number) => id === 10 ? held : [{ id: 20, name: "Other", chapterNumber: "1" }]);
    const runtime = await import("./vpn-download-runtime");
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    await runtime.startVpnDownloadRun(options);
    const first = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Cancelled preparation" })!;
    const second = interceptChapterDownloadBatch({ jobs: [{ ...jobs[0]!, id: 20, novelId: 20, chapterPath: "/chapter/20" }], title: "Retained work" })!;
    try {
      await vi.waitFor(() => expect(boundary.pendingJobs.has(8)).toBe(true));
      expect(cancelInterceptedChapterDownloadBatch(first.id)).toBe(true);
      release(catalog);
      await first.materialized;
      await expect(first.promise).resolves.toMatchObject({ cancelled: 1, succeeded: 0 });
      await second.materialized;
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
      expect(boundary.enqueue.mock.calls[0]![0].id).toBe(20);
      expect(boundary.pendingJobs.has(8)).toBe(false);
    } finally { release(catalog); await runtime.cancelVpnDownloadRun(); }
  });

  it("does not launch duplicate chapter owners when the same intent is submitted twice", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const first = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Same work" })!;
    const second = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Same work" })!;
    await Promise.all([first.materialized, second.materialized]);
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    expect(boundary.createPlan).toHaveBeenCalledTimes(1);
    await runtime.cancelVpnDownloadRun();
  });

  it("enrolls more chunks than workers and lets the one worker take them in order", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun({ ...options, workerCount: 1 });
    const batch = interceptChapterDownloadBatch({ jobs, title: "Chunked work" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    try {
      const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
      expect(plan.ranges.map(range => range.chapterIds)).toEqual([[8, 2], [9, 3]]);
      expect(boundary.enqueue.mock.calls[0]![0].id).toBe(8);
      boundary.complete.get(8)!(); await tick();
      boundary.complete.get(2)!();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(3));
      expect(boundary.enqueue.mock.calls[2]![0].id).toBe(9);
      boundary.complete.get(9)!(); await tick();
      boundary.complete.get(3)!();
      await expect(batch.promise).resolves.toMatchObject({ succeeded: 4, cancelled: 0 });
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  async function restartProcess(maxWorkers = 2) {
    vi.resetModules(); boundary.listeners.clear();
    vi.stubGlobal("window", new EventTarget());
    Object.assign(window, { localStorage, __NoreaAndroidVpnWorkers: { capabilities: () => JSON.stringify({ supported: true, parallelSupported: true, maxWorkers }) } });
    ({ interceptChapterDownloadBatch } = await import("./chapter-download-batch-interceptor"));
    return import("./vpn-download-runtime");
  }

  async function startTwoRanges(runtime: typeof import("./vpn-download-runtime")) {
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs, title: "Restarted work" })!.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
    const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
    return { plan, automatic: plan.ranges[0]!, manual: plan.ranges[1]! };
  }

  it("resumes the whole run after an ordinary restart while an individually paused range stays paused", async () => {
    const runtime = await import("./vpn-download-runtime");
    const { plan, automatic, manual } = await startTwoRanges(runtime);
    await runtime.pauseVpnDownloadRange(plan.id, manual.id);
    const restored = await restartProcess();
    await restored.initializeVpnDownloadRuntime();
    try {
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(3));
      expect(boundary.enqueue.mock.calls[2]![0].id).toBe(8);
      expect(restored.getVpnDownloadRuntimeSnapshot().run?.status).toBe("running");
      const ranges = restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges;
      expect(ranges.find(range => range.id === automatic.id)).toMatchObject({ phase: "running", userPaused: false });
      expect(ranges.find(range => range.id === manual.id)).toMatchObject({ phase: "paused", userPaused: true, pauseReason: "user-paused" });
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it.each(["challenge-forbidden", "site-forbidden"] as const)("keeps %s held through restart and run Resume while another range continues", async pauseReason => {
    const runtime = await import("./vpn-download-runtime");
    const { plan, automatic: forbidden, manual: healthy } = await startTwoRanges(runtime);
    if (pauseReason === "challenge-forbidden") {
      const worker = boundary.enqueue.mock.calls.find(([job]) => job.id === 8)![1] as VpnDownloadWorkerRef;
      const challenge = { kind: "forbidden" as const, url: "https://source.test/chapter/8" };
      boundary.blocks = [{
        sourceId: plan.pluginId, rangeId: worker.rangeId, workerGeneration: worker.generation,
        originTaskId: "task:8", challenge, scopeKey: sourceAccessScopeKey(challenge.url, plan.pluginId, worker.rangeId),
        revision: 1, detectedAt: 1, verificationRequested: false,
      }];
      for (const listener of boundary.listeners) listener();
    } else boundary.reject.get(8)!(new Error("HTTP 403 Forbidden on https://source.test/chapter/8"));
    await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.find(range => range.id === forbidden.id)?.pauseReason).toBe(pauseReason));
    const restored = await restartProcess();
    await restored.initializeVpnDownloadRuntime();
    try {
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(3));
      expect(boundary.enqueue.mock.calls[2]![0].id).toBe(9);
      expect(restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.find(range => range.id === forbidden.id))
        .toMatchObject({ phase: "paused", pauseReason, checkpoint: 0 });
      await restored.pauseVpnDownloadRun();
      await restored.resumeVpnDownloadRun();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(4));
      expect(boundary.enqueue.mock.calls[3]![0].id).toBe(9);
      const ranges = restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges;
      expect(ranges.find(range => range.id === forbidden.id)).toMatchObject({ phase: "paused", pauseReason, checkpoint: 0 });
      expect(ranges.find(range => range.id === healthy.id)?.phase).toBe("running");
      await restored.pauseVpnDownloadWork(plan.pluginId, plan.novelId);
      await restored.resumeVpnDownloadWork(plan.pluginId, plan.novelId);
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(5));
      expect(boundary.enqueue.mock.calls[4]![0].id).toBe(9);
      expect(restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.find(range => range.id === forbidden.id))
        .toMatchObject({ phase: "paused", pauseReason, checkpoint: 0 });
      expect(boundary.enqueue.mock.calls.filter(([job]) => job.id === 8)).toHaveLength(1);
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it("does not create a hidden work hold when whole-work Pause targets only a forbidden range", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Forbidden work" })!.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    boundary.reject.get(8)!(new Error("HTTP 403 Forbidden on https://source.test/chapter/8"));
    await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]?.pauseReason).toBe("site-forbidden"));
    try {
      const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
      await runtime.pauseVpnDownloadWork(plan.pluginId, plan.novelId);
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]).toMatchObject({ pauseReason: "site-forbidden", userPaused: false });
      await runtime.resumeVpnDownloadRange(plan.id, plan.ranges[0]!.id);
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
      await interceptChapterDownloadBatch({ jobs: [jobs[2]!], title: "New work" })!.materialized;
      expect(boundary.persistPending.mock.calls.at(-1)![1][0].vpnWorkPaused).toBeUndefined();
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("keeps a run paused by the user across a restart even when restart resume is on", async () => {
    const runtime = await import("./vpn-download-runtime");
    await startTwoRanges(runtime);
    await runtime.pauseVpnDownloadRun();
    const restored = await restartProcess();
    await restored.initializeVpnDownloadRuntime(); await tick();
    try {
      expect(boundary.enqueue).toHaveBeenCalledTimes(2);
      expect(restored.getVpnDownloadRuntimeSnapshot().run?.status).toBe("interrupted");
      expect(restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.every(range => range.pauseReason === "automatic-off")).toBe(true);
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it("waits for one run-level Resume after a restart when restart resume is off", async () => {
    const runtime = await import("./vpn-download-runtime");
    const { automatic } = await startTwoRanges(runtime);
    useVpnDownloadStore.getState().setResumeAfterRestart(false);
    const restored = await restartProcess();
    await restored.initializeVpnDownloadRuntime(); await tick();
    try {
      expect(boundary.enqueue).toHaveBeenCalledTimes(2);
      expect(restored.getVpnDownloadRuntimeSnapshot().run?.status).toBe("interrupted");
      expect(restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.find(range => range.id === automatic.id)).toMatchObject({ phase: "paused", pauseReason: "interrupted" });
      await restored.resumeVpnDownloadRun();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(4));
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it("never resumes restored plans automatically after a device restore reload", async () => {
    const runtime = await import("./vpn-download-runtime");
    await startTwoRanges(runtime);
    await runtime.suspendVpnDownloadsForRestore();
    for (const plan of boundary.plans.values()) for (const range of plan.ranges) Object.assign(range, { phase: "running", pauseReason: null });
    const connections = boundary.connect.mock.calls.length;
    const restored = await restartProcess();
    await restored.initializeVpnDownloadRuntime(); await tick();
    try {
      expect(boundary.connect).toHaveBeenCalledTimes(connections);
      expect(restored.getVpnDownloadRuntimeSnapshot().run?.status).toBe("interrupted");
      expect(restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.every(range => range.pauseReason === "interrupted")).toBe(true);
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it("fills every worker slot after restart while a failing foreground reconnect holds one assigned profile", async () => {
    const pool = Array.from({ length: 19 }, (_, index) => ({
      id: `p${index}`, hash: `hash-p${index}`, ip: `192.0.2.${index + 1}`, protocol: "tcp", approvedAt: index + 1, approvalSequence: index + 1,
    }));
    const foreground = pool[0]!;
    // Every work was planned from the same ordered pool, so the foreground profile and the leading profiles repeat across plans.
    for (let work = 0; work < 13; work++) {
      const id = `plan-${work}`; const novelId = 100 + work;
      const ranges = Array.from({ length: work === 12 ? 5 : 6 }, (_, index) => {
        const chapterId = novelId * 100 + index;
        return { id: `${id}-${index}`, profileId: pool[index]!.id, profileHash: pool[index]!.hash, startChapterId: chapterId, endChapterId: chapterId,
          chapterIds: [chapterId], selectedChapterIds: [chapterId], checkpoint: 0, phase: "paused" as const, userPaused: false, pauseReason: "interrupted",
          attemptedProfileIds: [], attemptProfileId: null, generation: 0, challenge: null };
      });
      boundary.plans.set(id, { id, batchId: "device-run", pluginId: "source-test", novelId, title: `Work ${work}`, mode: "parallel",
        policies: { captcha: "nextProfile", cloudflare: "nextProfile" }, createdAt: 1, revision: 0, ranges });
      for (const range of ranges) boundary.jobs.push({ id: range.selectedChapterIds[0]!, pluginId: "source-test", novelId, novelName: `Work ${work}`,
        chapterPath: `/chapter/${range.selectedChapterIds[0]}`, title: `Chapter ${range.selectedChapterIds[0]}`,
        batchId: "device-run", vpnBatchId: "device-run", vpnPlanId: id, vpnRangeId: range.id });
    }
    expect([...boundary.plans.values()].flatMap(plan => plan.ranges)).toHaveLength(77);
    boundary.catalog.mockImplementation(async (novelId: number) => boundary.jobs.filter(job => job.novelId === novelId)
      .map(job => ({ id: job.id, name: job.title, chapterNumber: `${job.id}` })));
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: pool, cleanupError: null });
    // Reconnect backoff: the foreground is requested and keeps its profile while its status reads disabled.
    boundary.status.mockResolvedValue({ phase: "disabled", profile: { hash: foreground.hash, remoteHost: foreground.ip }, supported: true, proxyPort: 123, error: null });
    boundary.connect.mockImplementation(async (worker, profile) => {
      if (profile.id === foreground.id) throw Object.assign(new Error("saved VPN profile is the current foreground profile"), { code: "vpn-worker-runtime-error" });
      return { supported: true, worker, phase: "connected", profile: pool.find(candidate => candidate.id === profile.id), proxyPort: 12000 + worker.slot, error: null };
    });
    useVpnDownloadStore.setState({ workerCount: 10 });
    const restored = await restartProcess(10);
    (await import("../../store/plugin-vpn")).usePluginVpnStore.setState({ enabled: true });
    await restored.initializeVpnDownloadRuntime();
    try {
      await vi.waitFor(() => expect(boundary.configure).toHaveBeenCalledTimes(10), { timeout: 3_000 });
      await tick();
      const ranges = restored.getVpnDownloadRuntimeSnapshot().plans.flatMap(plan => plan.ranges);
      expect(boundary.connect.mock.calls.map(([, profile]) => profile.id)).not.toContain(foreground.id);
      expect(ranges.filter(range => range.pauseReason === "runtime-error")).toEqual([]);
      expect(new Set(boundary.configure.mock.calls.map(([, config]) => config.profileId)).size).toBe(10);
      expect(boundary.enqueue).toHaveBeenCalledTimes(10);
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it("leases the browsing profile to a worker once its automatic recovery stopped and released it", async () => {
    const foreground = { id: "p0", hash: "hash-p0", ip: "192.0.2.1", protocol: "tcp", approvedAt: 1, approvalSequence: 1 };
    const range = { id: "plan-0-0", profileId: foreground.id, profileHash: foreground.hash, startChapterId: 700, endChapterId: 700,
      chapterIds: [700], selectedChapterIds: [700], checkpoint: 0, phase: "paused" as const, userPaused: false, pauseReason: "interrupted",
      attemptedProfileIds: [], attemptProfileId: null, generation: 0, challenge: null };
    boundary.plans.set("plan-0", { id: "plan-0", batchId: "device-run", pluginId: "source-test", novelId: 7, title: "Work", mode: "parallel",
      policies: { captcha: "nextProfile", cloudflare: "nextProfile" }, createdAt: 1, revision: 0, ranges: [range] });
    boundary.jobs.push({ id: 700, pluginId: "source-test", novelId: 7, novelName: "Work", chapterPath: "/chapter/700", title: "Chapter 700",
      batchId: "device-run", vpnBatchId: "device-run", vpnPlanId: "plan-0", vpnRangeId: range.id });
    boundary.catalog.mockImplementation(async () => [{ id: 700, name: "Chapter 700", chapterNumber: "700" }]);
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [foreground], cleanupError: null });
    boundary.status.mockResolvedValue({ phase: "disabled", profile: { hash: foreground.hash, remoteHost: foreground.ip }, supported: true, proxyPort: 123, error: null });
    boundary.recoveryStopped.mockReturnValue(true);
    boundary.connect.mockImplementation(async (worker, profile) =>
      ({ supported: true, worker, phase: "connected", profile: { ...foreground, id: profile.id }, proxyPort: 12000, error: null }));
    const restored = await restartProcess(1);
    (await import("../../store/plugin-vpn")).usePluginVpnStore.setState({ enabled: true });
    await restored.initializeVpnDownloadRuntime();
    try {
      await vi.waitFor(() => expect(boundary.connect).toHaveBeenCalled(), { timeout: 3_000 });
      expect(boundary.connect.mock.calls.map(([, profile]) => profile.id)).toEqual([foreground.id]);
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it("restores pending ownership as interrupted and requires explicit resume before connecting", async () => {
    useVpnDownloadStore.getState().setResumeAfterRestart(false);
    boundary.pendingJobs.set(8, { ...jobs[0]!, vpnBatchId: "retained-run" });
    const runtime = await import("./vpn-download-runtime");
    await runtime.initializeVpnDownloadRuntime(); await tick();
    expect(runtime.getVpnDownloadRuntimeSnapshot().run).toMatchObject({ id: "retained-run", status: "interrupted" });
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(boundary.pendingJobs.has(8)).toBe(true);
    await runtime.resumeVpnDownloadRun();
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.batchId).toBe("retained-run");
    await runtime.cancelVpnDownloadRun();
  });

  it("keeps the enrolled-only run identity so new work after restart observes its existing profile exclusion", async () => {
    boundary.connect.mockImplementationOnce(async () => { throw Object.assign(new Error("Tunnel refused"), { code: "plugin-vpn-unavailable" }); });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun({ ...options, workerCount: 1 });
    const batch = interceptChapterDownloadBatch({ jobs: jobs.slice(0, 2), title: "Existing execution" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    const batchId = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.batchId;
    expect(boundary.issues).toMatchObject([{ batchId, profileId: "profile-a", excluded: true }]);
    boundary.complete.get(8)!();
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
    await runtime.pauseVpnDownloadRun();
    expect(boundary.pendingJobs.size).toBe(0);
    vi.resetModules(); boundary.listeners.clear();
    vi.stubGlobal("window", new EventTarget());
    Object.assign(window, { localStorage, __NoreaAndroidVpnWorkers: { capabilities: () => JSON.stringify({ supported: true, parallelSupported: true, maxWorkers: 2 }) } });
    ({ interceptChapterDownloadBatch } = await import("./chapter-download-batch-interceptor"));
    const restored = await import("./vpn-download-runtime");
    await restored.initializeVpnDownloadRuntime();
    try {
      expect(restored.getVpnDownloadRuntimeSnapshot().run).toMatchObject({ id: batchId, status: "interrupted" });
      await restored.resumeVpnDownloadRun();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(3));
      boundary.catalog.mockResolvedValueOnce([{ id: 20, name: "New work chapter", chapterNumber: "1" }]);
      const request = interceptChapterDownloadBatch({ jobs: [{ ...jobs[0]!, id: 20, novelId: 20, novelName: "New work" }], title: "New work" })!;
      await request.materialized;
      await vi.waitFor(() => expect(boundary.pendingJobs.has(20) || restored.getVpnDownloadRuntimeSnapshot().plans.length === 2).toBe(true));
      boundary.complete.get(2)!();
      await vi.waitFor(() => expect(boundary.enqueue.mock.calls.some(([job]) => job.id === 20)).toBe(true));
      expect(restored.getVpnDownloadRuntimeSnapshot().plans.map(plan => plan.batchId)).toEqual([batchId, batchId]);
      expect(boundary.connect.mock.calls.slice(2).every(([, profile]) => profile.id === "profile-b")).toBe(true);
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it("keeps paused preparation durable across profile events and resumes only on user intent", async () => {
    let release!: (value: typeof catalog) => void;
    const held = new Promise<typeof catalog>(resolve => { release = resolve; });
    boundary.catalog.mockReturnValueOnce(held);
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Paused work" })!;
    await batch.materialized;
    await runtime.pauseVpnDownloadRun(); release(catalog);
    window.dispatchEvent(new Event("norea-vpn-profiles-changed")); await tick();
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(boundary.pendingJobs.has(8)).toBe(true);
    await runtime.resumeVpnDownloadRun();
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    await runtime.cancelVpnDownloadRun();
  });

  it("pauses an entire work including its automatic capacity waiter before releasing the active sibling", async () => {
    const runtime = await import("./vpn-download-runtime");
    const pool = [...profiles, { ...profiles[0]!, id: "profile-c", hash: "hash-c", ip: "192.0.2.3" }];
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: pool, cleanupError: null });
    boundary.connect.mockImplementation(async (worker, profile) => ({ supported: true, worker, phase: "connected", profile: pool.find(candidate => candidate.id === profile.id), proxyPort: 12000 + worker.slot, error: null }));
    boundary.catalog.mockImplementation(async (id: number) => id === 20 ? [{ id: 20, name: "Other", chapterNumber: "1" }] : catalog);
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs: [{ ...jobs[0]!, id: 20, novelId: 20 }], title: "Other work" })!.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    await interceptChapterDownloadBatch({ jobs, title: "Work with a waiter" })!.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
    try {
      await runtime.pauseVpnDownloadWork("source-test", 10);
      window.dispatchEvent(new Event("norea-vpn-profiles-changed")); await tick();
      expect(boundary.enqueue).toHaveBeenCalledTimes(2);
      const work = runtime.getVpnDownloadRuntimeSnapshot().plans.find(plan => plan.novelId === 10)!;
      expect(work.ranges).toHaveLength(2);
      expect(work.ranges.every(range => range.userPaused && range.pauseReason === "work-paused")).toBe(true);
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("keeps a paused preparation held after reload and run Resume until that work is resumed", async () => {
    let finish!: (value: typeof catalog) => void;
    const held = new Promise<typeof catalog>(resolve => { finish = resolve; });
    boundary.catalog.mockReturnValueOnce(held);
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Paused pending work" })!.materialized;
    await runtime.pauseVpnDownloadWork("source-test", 10);
    finish(catalog); await tick();
    expect(boundary.pendingJobs.get(8)).toMatchObject({ vpnWorkPaused: true });
    expect(boundary.enqueue).not.toHaveBeenCalled();
    await runtime.pauseVpnDownloadRun();
    vi.resetModules(); boundary.listeners.clear();
    vi.stubGlobal("window", new EventTarget());
    Object.assign(window, { localStorage, __NoreaAndroidVpnWorkers: { capabilities: () => JSON.stringify({ supported: true, parallelSupported: true, maxWorkers: 2 }) } });
    const restored = await import("./vpn-download-runtime");
    await restored.initializeVpnDownloadRuntime();
    try {
      await restored.resumeVpnDownloadRun(); await tick();
      expect(boundary.enqueue).not.toHaveBeenCalled();
      await restored.resumeVpnDownloadWork("source-test", 10);
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    } finally { finish(catalog); await restored.cancelVpnDownloadRun(); }
  });

  it("keeps a work paused when its plan publication finishes after the work pause", async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const create = boundary.createPlan.getMockImplementation()!;
    boundary.createPlan.mockImplementationOnce(async (...args) => { await held; return create(...args); });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Publishing work" })!.materialized;
    await vi.waitFor(() => expect(boundary.createPlan).toHaveBeenCalledOnce());
    await runtime.pauseVpnDownloadWork("source-test", 10);
    finish();
    try {
      await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toHaveLength(1));
      expect(boundary.enqueue).not.toHaveBeenCalled();
      await runtime.resumeVpnDownloadWork("source-test", 10);
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    } finally { finish(); await runtime.cancelVpnDownloadRun(); }
  });

  it("resumes a plan published after run Pause without treating that run hold as an individual pause", async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const create = boundary.createPlan.getMockImplementation()!;
    boundary.createPlan.mockImplementationOnce(async (...args) => { await held; return create(...args); });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Late run publication" })!.materialized;
    await vi.waitFor(() => expect(boundary.createPlan).toHaveBeenCalledOnce());
    await runtime.pauseVpnDownloadRun();
    finish();
    try {
      await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toHaveLength(1));
      expect(boundary.enqueue).not.toHaveBeenCalled();
      await runtime.resumeVpnDownloadRun();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    } finally { finish(); await runtime.cancelVpnDownloadRun(); }
  });

  it("resumes work-held ranges without overriding a separately paused range", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs, title: "Independently held sibling" })!.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
    const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
    await runtime.pauseVpnDownloadRange(plan.id, plan.ranges[1]!.id);
    await runtime.pauseVpnDownloadWork("source-test", 10);
    try {
      await runtime.resumeVpnDownloadWork("source-test", 10);
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(3));
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[1]).toMatchObject({ userPaused: true, pauseReason: "user-paused" });
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("forgets a cancelled work hold before accepting a new request for that work", async () => {
    const runtime = await import("./vpn-download-runtime");
    boundary.catalog.mockImplementation(async (id: number) => id === 20 ? [{ id: 20, name: "Other", chapterNumber: "1" }] : catalog);
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs: [{ ...jobs[0]!, id: 20, novelId: 20 }], title: "Other work" })!.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [], cleanupError: null });
    await interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "First request" })!.materialized;
    await runtime.pauseVpnDownloadWork("source-test", 10);
    const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
    await runtime.cancelVpnDownloadDraft(draft.id);
    boundary.profiles.mockResolvedValue({ limit: 20, profiles, cleanupError: null });
    await interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "New explicit request" })!.materialized;
    try { await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2)); }
    finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("coalesces overlapping chapters while accepting only the new portion of a later request", async () => {
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [], cleanupError: null });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const first = interceptChapterDownloadBatch({ jobs: jobs.slice(0, 2), title: "First selection" })!;
    await first.materialized;
    const second = interceptChapterDownloadBatch({ jobs: jobs.slice(1, 3), title: "Overlapping selection" })!;
    await second.materialized;
    const ids = runtime.getVpnDownloadRuntimeSnapshot().drafts.flatMap(work => [...work.selectedChapterIds]);
    expect(ids.sort((a, b) => a - b)).toEqual([2, 8, 9]);
    await runtime.cancelVpnDownloadRun();
  });

  it("does not resume pending work after explicit VPN off is followed by a profile notification", async () => {
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [], cleanupError: null });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Explicitly stopped" })!;
    await batch.materialized;
    window.dispatchEvent(new Event("norea-plugin-vpn-explicit-off"));
    useVpnDownloadStore.getState().setMode("parallel");
    boundary.profiles.mockResolvedValue({ limit: 20, profiles, cleanupError: null });
    window.dispatchEvent(new Event("norea-vpn-profiles-changed")); await tick();
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("paused");
    await runtime.resumeVpnDownloadRun();
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    await runtime.cancelVpnDownloadRun();
  });

  it("waits for accepted queue publication before granting a device-restore hold and leaves the run paused", async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const persist = boundary.persistPending.getMockImplementation()!;
    boundary.persistPending.mockImplementationOnce(async (...args) => { await held; await persist(...args); });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Publishing intent" })!;
    let suspended = false;
    const suspending = runtime.suspendVpnDownloadsForRestore().then(release => { suspended = true; return release; });
    await tick();
    try { expect(suspended).toBe(false); }
    finally { finish(); }
    const release = await suspending;
    await batch.materialized;
    expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("paused");
    release();
    window.dispatchEvent(new Event("norea-vpn-profiles-changed")); await tick();
    expect(boundary.connect).not.toHaveBeenCalled();
    await runtime.cancelVpnDownloadRun();
  });

  it("counts a held browser cleanup in the run snapshot instead of reporting a free worker", async () => {
    const { pluginManager } = await import("../plugins/manager");
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Closing worker" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    boundary.close.mockImplementationOnce(async () => { await held; });
    const pausing = runtime.pauseVpnDownloadRun();
    await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledOnce());
    try {
      expect(runtime.getVpnDownloadRuntimeSnapshot().run).toMatchObject({ closingWorkers: 1, activeWorkers: 0 });
      expect(pluginManager.releaseExecutorRuntimes).not.toHaveBeenCalled();
    }
    finally { finish(); await pausing; await runtime.cancelVpnDownloadRun(); }
    expect(pluginManager.releaseExecutorRuntimes).toHaveBeenCalledOnce();
  });

  it("finishes an in-progress ownership commit before cancelling its run and cannot enroll the late result", async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const release = vi.fn();
    const commit = vi.fn(async (batchId: string) => {
      await held;
      const adopted = { ...jobs[0]!, vpnBatchId: batchId }; boundary.pendingJobs.set(adopted.id, adopted); return [adopted];
    });
    boundary.handover.mockResolvedValue({ jobs: [{ job: jobs[0], jobJson: JSON.stringify(jobs[0]), updatedAtMs: 1 }], pending: [], commitReady: commit, release });
    const runtime = await import("./vpn-download-runtime");
    const started = runtime.startVpnDownloadRun(options);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    let settled = false;
    const cancelled = runtime.cancelVpnDownloadRun().then(() => { settled = true; });
    await tick();
    try { expect(settled).toBe(false); }
    finally { finish(); await Promise.all([started, cancelled]); }
    expect(boundary.cancelOrdinary).toHaveBeenCalledWith([8]);
    expect(boundary.createPlan).not.toHaveBeenCalled();
    expect(boundary.pendingJobs.size).toBe(0);
    expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("cancelled");
    expect(release).toHaveBeenCalledOnce();
  });

  it("coalesces repeated run cancellation while the same browser cleanup is still pending", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Cancel once" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    boundary.close.mockImplementationOnce(async () => { await held; });
    const first = runtime.cancelVpnDownloadRun();
    let settled = false;
    const second = runtime.cancelVpnDownloadRun().then(() => { settled = true; });
    await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledOnce());
    try { expect(settled).toBe(false); }
    finally { finish(); await Promise.all([first, second]); }
    expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("cancelled");
  });

  it("does not confirm run cancellation until ordinary deletion settles and permits retry after deletion fails", async () => {
    let reject!: (error: Error) => void;
    const deleting = new Promise<void>((_, fail) => { reject = fail; });
    void deleting.catch(() => undefined);
    const failure = new Error("Ordinary queue deletion failed");
    boundary.handover.mockResolvedValue({ jobs: [{ job: jobs[0]!, jobJson: JSON.stringify(jobs[0]), updatedAtMs: 1 }], pending: [], commitReady: async () => [], release: vi.fn() });
    boundary.discardOrdinary.mockReturnValueOnce(deleting);
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    let settled = false;
    const cancelling = runtime.cancelVpnDownloadRun().finally(() => { settled = true; });
    const outcome = cancelling.then(() => null, error => error);
    await vi.waitFor(() => expect(boundary.discardOrdinary).toHaveBeenCalledOnce());
    try { expect(settled).toBe(false); }
    finally { reject(failure); expect(await outcome).toBe(failure); }
    expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("paused");
    await runtime.cancelVpnDownloadRun();
    expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("cancelled");
  });

  it("lets an explicit cancel retry finish after a failed browser cleanup instead of reporting a false terminal run", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Retry cleanup" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    const failure = new Error("Browser close failed");
    boundary.close.mockRejectedValue(failure);
    await expect(runtime.cancelVpnDownloadRun()).rejects.toBe(failure);
    boundary.close.mockResolvedValue(undefined);
    await runtime.cancelVpnDownloadRun();
    expect(boundary.close).toHaveBeenCalledTimes(2);
    expect(runtime.getVpnDownloadRuntimeSnapshot().run).toMatchObject({ status: "cancelled", activeWorkers: 0, closingWorkers: 0 });
  });

  it("resumes run-paused active ranges while preserving a separately paused range", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs, title: "Resume active work" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
    const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
    const [automatic, manual] = plan.ranges;
    try {
      await runtime.pauseVpnDownloadRange(plan.id, manual!.id);
      await runtime.pauseVpnDownloadRun();
      await runtime.resumeVpnDownloadRun();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(3));
      const ranges = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges;
      expect(ranges.find(range => range.id === automatic!.id)).toMatchObject({ phase: "running", userPaused: false });
      expect(ranges.find(range => range.id === manual!.id)).toMatchObject({ phase: "paused", userPaused: true });
      expect(boundary.enqueue.mock.calls[2]![0].id).toBe(8);
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("resumes run-paused ranges after a process restart without resuming an individually paused range", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs, title: "Restart paused work" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
    const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
    const [automatic, manual] = plan.ranges;
    await runtime.pauseVpnDownloadRange(plan.id, manual!.id);
    await runtime.pauseVpnDownloadRun();
    vi.resetModules(); boundary.listeners.clear();
    vi.stubGlobal("window", new EventTarget());
    Object.assign(window, { localStorage, __NoreaAndroidVpnWorkers: { capabilities: () => JSON.stringify({ supported: true, parallelSupported: true, maxWorkers: 2 }) } });
    const restored = await import("./vpn-download-runtime");
    await restored.initializeVpnDownloadRuntime();
    expect(restored.getVpnDownloadRuntimeSnapshot().run?.status).toBe("interrupted");
    try {
      await restored.resumeVpnDownloadRun();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(3));
      const ranges = restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges;
      expect(ranges.find(range => range.id === automatic!.id)).toMatchObject({ phase: "running", userPaused: false });
      expect(ranges.find(range => range.id === manual!.id)).toMatchObject({ phase: "paused", userPaused: true });
      expect(boundary.enqueue.mock.calls[2]![0].id).toBe(8);
    } finally { await restored.cancelVpnDownloadRun(); }
  });

  it.each(["pause", "restore"] as const)("does not resume a later restored range after %s interrupts an earlier launch write", async action => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await interceptChapterDownloadBatch({ jobs, title: "Existing plans" })!.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
    await runtime.pauseVpnDownloadRun();
    vi.resetModules(); boundary.listeners.clear();
    vi.stubGlobal("window", new EventTarget());
    Object.assign(window, { localStorage, __NoreaAndroidVpnWorkers: { capabilities: () => JSON.stringify({ supported: true, parallelSupported: true, maxWorkers: 2 }) } });
    const queries = await import("../../db/queries/vpn-download-plans");
    const update = queries.updateVpnDownloadPlan;
    let finish!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let blocked = false;
    vi.spyOn(queries, "updateVpnDownloadPlan").mockImplementation(async (...args) => {
      if (!blocked && args[0].ranges.some(range => range.phase === "paused" && range.pauseReason === null)) {
        blocked = true; enter(); await held;
      }
      return update(...args);
    });
    const restored = await import("./vpn-download-runtime");
    await restored.initializeVpnDownloadRuntime();
    const starting = restored.resumeVpnDownloadRun();
    await entered;
    const stopping = action === "pause" ? restored.pauseVpnDownloadRun() : restored.suspendVpnDownloadsForRestore();
    finish();
    try {
      const release = await stopping;
      await starting; await tick();
      if (release) release();
      expect(boundary.connect).toHaveBeenCalledTimes(2);
      expect(restored.getVpnDownloadRuntimeSnapshot().run?.status).toBe("paused");
      expect(restored.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.every(range => range.phase === "paused")).toBe(true);
    } finally { finish(); await starting; await restored.cancelVpnDownloadRun(); }
  });

  it("waits for a resumed ownership commit during cancellation and rejects its late admission", async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const commit = vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(async (batchId: string) => {
      await held;
      const adopted = { ...jobs[0]!, vpnBatchId: batchId };
      boundary.pendingJobs.set(adopted.id, adopted);
      return [adopted];
    });
    boundary.handover.mockResolvedValue({ jobs: [{ job: jobs[0], jobJson: JSON.stringify(jobs[0]), updatedAtMs: 1 }], pending: [], commitReady: commit, release: vi.fn() });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await runtime.pauseVpnDownloadRun();
    const resuming = runtime.resumeVpnDownloadRun();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    let settled = false;
    const cancelling = runtime.cancelVpnDownloadRun().then(() => { settled = true; });
    await tick();
    try { expect(settled).toBe(false); }
    finally { finish(); await Promise.all([resuming, cancelling]); }
    expect(boundary.createPlan).not.toHaveBeenCalled();
    expect(boundary.pendingJobs.size).toBe(0);
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
    expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("cancelled");
  });

  it("requires Resume for a paused run instead of replacing its retained ordinary dispatch hold", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await runtime.pauseVpnDownloadRun();
    try {
      await expect(runtime.startVpnDownloadRun(options)).rejects.toThrow(/active|resume/i);
      expect(boundary.handover).toHaveBeenCalledOnce();
      expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("paused");
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("reacquires ordinary ownership on Resume after failed launch adoption released its hold", async () => {
    const failure = new Error("Adoption transaction failed");
    let released = false;
    const oldCommit = vi.fn(async () => { if (released) return []; throw failure; });
    boundary.handover.mockResolvedValueOnce({ jobs: [], pending: [], commitReady: oldCommit, release: () => { released = true; } });
    const runtime = await import("./vpn-download-runtime");
    await expect(runtime.startVpnDownloadRun(options)).rejects.toBe(failure);
    try {
      await runtime.resumeVpnDownloadRun();
      expect(boundary.handover).toHaveBeenCalledTimes(2);
      expect(oldCommit).toHaveBeenCalledOnce();
      expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("running");
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("releases unpersisted draft ownership after admission fails so the exact request can be retried", async () => {
    const failure = new Error("Pending intent write failed");
    boundary.persistPending.mockRejectedValueOnce(failure);
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const failed = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Failed admission" })!;
    await expect(failed.materialized).rejects.toBe(failure);
    try {
      expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().ownedChapterIds).not.toContain(8);
      const retry = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Retry admission" })!;
      await retry.materialized;
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    } finally { await runtime.cancelVpnDownloadRun(); }
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
  });

  it("retries a failed catalog on explicit run Resume without looping on ordinary profile notifications", async () => {
    const failure = new Error("Catalog temporarily unavailable");
    boundary.catalog.mockRejectedValueOnce(failure);
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Retry catalog" })!;
    await batch.materialized;
    await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]?.phase).toBe("failed"));
    window.dispatchEvent(new Event("norea-vpn-profiles-changed")); await tick();
    expect(boundary.catalog).toHaveBeenCalledOnce();
    try {
      await runtime.pauseVpnDownloadRun();
      await runtime.resumeVpnDownloadRun();
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
      expect(boundary.catalog).toHaveBeenCalledTimes(2);
      expect(boundary.pendingJobs.size).toBe(0);
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("keeps failed Resume paused and retryable instead of publishing a running status", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    await runtime.pauseVpnDownloadRun();
    const queue = await import("../../db/queries/chapter-download-queue");
    const failure = new Error("Queue read failed");
    vi.spyOn(queue, "listPendingVpnDownloadJobs").mockRejectedValueOnce(failure);
    try {
      await expect(runtime.resumeVpnDownloadRun()).rejects.toBe(failure);
      expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("paused");
      await runtime.resumeVpnDownloadRun();
      expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("running");
    } finally { await runtime.cancelVpnDownloadRun(); }
  });

  it("keeps repeated draft cancellation pending until its durable deletion finishes", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    boundary.catalog.mockImplementation(() => new Promise(() => undefined));
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Cancel draft durably" })!;
    await batch.materialized;
    const queue = await import("../../db/queries/chapter-download-queue");
    const remove = queue.cancelPendingVpnDownloadJobs;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(queue, "cancelPendingVpnDownloadJobs").mockImplementationOnce(async (...args) => { await held; return remove(...args); });
    const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
    let settled = 0;
    const first = Promise.resolve(runtime.cancelVpnDownloadDraft(draft.id)).then(() => { settled++; });
    const second = Promise.resolve(runtime.cancelVpnDownloadDraft(draft.id)).then(() => { settled++; });
    await tick();
    try { expect(settled).toBe(0); expect(boundary.pendingJobs.has(8)).toBe(true); }
    finally { finish(); await Promise.all([first, second]); await runtime.cancelVpnDownloadRun(); }
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
  });

  it("keeps a run active while a newly accepted request is still preparing its source catalog", async () => {
    const runtime = await import("./vpn-download-runtime");
    const requests = await import("./chapter-download-requests");
    await runtime.startVpnDownloadRun(options);
    const first = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Finishing work" })!;
    await first.materialized;
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledOnce());
    let finish!: (batch: Parameters<typeof interceptChapterDownloadBatch>[0]) => void;
    const preparing = requests.submitChapterDownloadRequest({ key: "new-work", title: "New work", novelIds: [10],
      prepare: () => new Promise(resolve => { finish = resolve; }) });
    try {
      boundary.complete.get(8)!();
      await first.promise;
      expect(runtime.getVpnDownloadRuntimeSnapshot().run?.status).toBe("running");
      finish({ jobs: [jobs[1]!], title: "New work" });
      await preparing.materialized;
      await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
      expect(boundary.enqueue.mock.calls[1]![0].id).toBe(2);
    } finally { requests.cancelChapterDownloadRequest(preparing.id); await runtime.cancelVpnDownloadRun(); }
  });

  it("cancels accepted preparation with its VPN run instead of later releasing it onto ordinary routing", async () => {
    const runtime = await import("./vpn-download-runtime");
    const requests = await import("./chapter-download-requests");
    await runtime.startVpnDownloadRun(options);
    let finish!: (batch: Parameters<typeof interceptChapterDownloadBatch>[0]) => void;
    let signal!: AbortSignal;
    const preparing = requests.submitChapterDownloadRequest({ key: "held-work", title: "Held work", novelIds: [10],
      prepare: value => { signal = value; return new Promise(resolve => { finish = resolve; }); } });
    await runtime.cancelVpnDownloadRun();
    finish({ jobs: [jobs[0]!], title: "Held work" });
    await tick();
    expect(signal.aborted).toBe(true);
    expect(requests.getChapterDownloadRequestSnapshot()).toEqual([]);
    expect(boundary.requestEnqueue).not.toHaveBeenCalled();
    await expect(preparing.materialized).rejects.toMatchObject({ name: "AbortError" });
  });

  it("shows each ordinary in-flight handover work and cancels only its requested work identity", async () => {
    let settle!: () => void;
    const held = new Promise<void>(resolve => { settle = resolve; });
    const stored = { job: jobs[0]!, jobJson: JSON.stringify(jobs[0]), updatedAtMs: 1 };
    boundary.handover.mockResolvedValue({ jobs: [stored], pending: [{ job: stored, settled: held }], commitReady: async () => [], release: vi.fn() });
    const runtime = await import("./vpn-download-runtime");
    await runtime.startVpnDownloadRun(options);
    try {
      const snapshot = runtime.getVpnDownloadRuntimeSnapshot();
      expect(snapshot.handover).toMatchObject([{ title: "Work", novelId: 10, chapterIds: [8] }]);
      expect(snapshot.ownedChapterIds).toContain(8);
      await runtime.cancelVpnDownloadHandoverWork(snapshot.handover![0]!.id);
      expect(boundary.cancelOrdinary).toHaveBeenCalledWith([8]);
    } finally { settle(); await runtime.cancelVpnDownloadRun(); }
  });
});

it("recognizes the native ten-worker capability without inventing a lower hardware limit", async () => {
  Object.assign(window, { __NoreaAndroidVpnWorkers: { capabilities: () => JSON.stringify({ supported: true, parallelSupported: true, maxWorkers: 10 }) } });
  const runtime = await import("./vpn-download-runtime");
  await runtime.initializeVpnDownloadRuntime();
  expect(runtime.getVpnDownloadRuntimeSnapshot().capabilities).toEqual({ supported: true, parallelSupported: true, maxWorkers: 10 });
});

describe("VPN download production integration", () => {
  async function initializePausedRun(runtime: typeof import("./vpn-download-runtime")) {
    const settings = useVpnDownloadStore.getState();
    await runtime.startVpnDownloadRun({ workerCount: settings.mode === "single" ? 1 : settings.workerCount,
      captchaPolicy: settings.captchaPolicy, cloudflarePolicy: settings.cloudflarePolicy });
    useVpnDownloadStore.setState({ mode: settings.mode, workerCount: settings.workerCount });
    await runtime.pauseVpnDownloadRun();
  }
  it("resumes an exhausted batch when the shared profile mutation boundary publishes a new healthy O file", async () => {
    const runtime = await import("./vpn-download-runtime"); await initializePausedRun(runtime);
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [profiles[0]!], cleanupError: null });
    boundary.connect.mockImplementation(async (worker, profile) => {
      if (profile.id === "profile-a") throw Object.assign(new Error("Tunnel refused"), { code: "plugin-vpn-unavailable" });
      return { supported: true, worker, phase: "connected", profile: profiles[1], proxyPort: 12000 + worker.slot, error: null };
    });
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!; await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [{ startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]?.pauseReason).toBe("profiles-exhausted"));
    boundary.profiles.mockResolvedValue({ limit: 20, profiles, cleanupError: null });
    window.dispatchEvent(new Event("norea-vpn-profiles-changed"));
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]?.profileId).toBe("profile-b");
    boundary.complete.get(8)!(); await tick(); await expect(batch.promise).resolves.toMatchObject({ succeeded: 1 });
  });
  it("waits for a foreground-occupied IP variant instead of leasing or excluding it", async () => {
    const runtime = await import("./vpn-download-runtime"); await initializePausedRun(runtime);
    boundary.status.mockResolvedValue({ phase: "connected", profile: { hash: "udp-variant", remoteHost: profiles[0]!.ip, isVpnGateFinder: true }, supported: true, proxyPort: 123, error: null });
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!; await batch.materialized;
    const draftId = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id;
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [profiles[0]!], cleanupError: null });
    await runtime.startVpnDownloadDraft(draftId, [{ startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]?.ranges[0]).toMatchObject({ phase: "paused", pauseReason: null }));
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(boundary.issues).toEqual([]);
    boundary.status.mockResolvedValue({ phase: "disabled", profile: null, supported: true, proxyPort: 123, error: null });
    window.dispatchEvent(new Event("norea-vpn-profiles-changed"));
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    boundary.complete.get(8)!(); await tick(); await expect(batch.promise).resolves.toMatchObject({ succeeded: 1 });
  });

  it("can retry a failed browser close and finish cancellation without adopting a cached rejection", async () => {
    const runtime = await import("./vpn-download-runtime"); await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!; await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [{ startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!; const range = plan.ranges[0]!;
    const failure = new Error("Browser close failed"); boundary.close.mockRejectedValue(failure);
    await expect(runtime.pauseVpnDownloadRange(plan.id, range.id)).rejects.toBe(failure);
    boundary.close.mockResolvedValue(undefined);
    await runtime.cancelVpnDownloadRange(plan.id, range.id);
    await expect(batch.promise).resolves.toMatchObject({ cancelled: 1, succeeded: 0 });
    expect(boundary.close).toHaveBeenCalledTimes(2);
  });
  it("force-clears only its exact authentication wait and settles the old task and browser before retrying the chapter on a replacement", async () => {
    const runtime = await import("./vpn-download-runtime"); await initializePausedRun(runtime);
    const pool = [...profiles, { ...profiles[0]!, id: "profile-c", hash: "hash-c", ip: "192.0.2.3" }];
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: pool, cleanupError: null });
    boundary.connect.mockImplementation(async (worker, profile) => {
      boundary.effects.push(`connect:${worker.slot}`);
      return { supported: true, worker, phase: "connected", profile: pool.find(candidate => candidate.id === profile.id), proxyPort: 12000 + worker.slot, error: null };
    });
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!; await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [
      { startChapterId: 8, endChapterId: 2 },
      { startChapterId: 9, endChapterId: 3 },
    ]);
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(2));
    const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
    const oldWorker = boundary.enqueue.mock.calls.find(([job]) => job.id === 8)![1] as VpnDownloadWorkerRef;
    const challenge = { kind: "captcha" as const, url: "https://source.test/challenge" };
    const block: SourceAccessBlock = { sourceId: plan.pluginId, rangeId: oldWorker.rangeId, workerGeneration: oldWorker.generation,
      originTaskId: "task:8", challenge, scopeKey: sourceAccessScopeKey(challenge.url, plan.pluginId, oldWorker.rangeId),
      revision: 7, detectedAt: 1, verificationRequested: false };
    const sibling = { ...block, rangeId: "unrelated", originTaskId: "unrelated-task", scopeKey: "unrelated-scope" };
    let settle!: () => void; const sourceSettlement = new Promise<void>(resolve => { settle = resolve; });
    let close!: () => void; const browserClose = new Promise<void>(resolve => { close = resolve; });
    boundary.settleTask.mockImplementationOnce(() => sourceSettlement);
    boundary.close.mockImplementation(async worker => { if (worker.generation === oldWorker.generation) await browserClose; });
    boundary.blocks = [block, sibling]; for (const listener of boundary.listeners) listener();
    await vi.waitFor(() => expect(boundary.cancelTask).toHaveBeenCalledWith("task:8"));
    expect(boundary.blocks).toEqual([sibling]);
    expect(boundary.connect).toHaveBeenCalledTimes(2);
    settle(); await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledWith(oldWorker, plan.pluginId));
    expect(boundary.connect).toHaveBeenCalledTimes(2);
    close(); await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(3));
    const retry = boundary.enqueue.mock.calls[2]!;
    expect(retry[0]).toMatchObject({ id: 8, batchId: plan.batchId });
    expect(retry[1].generation).toBeGreaterThan(oldWorker.generation);
    expect(boundary.issues).toEqual([expect.objectContaining({ profileId: "profile-a", cause: "captcha", batchId: plan.batchId })]);
    expect(boundary.effects).not.toContain("settle:8");
    boundary.complete.get(8)!(); boundary.complete.get(9)!(); await tick();
    boundary.complete.get(2)!(); boundary.complete.get(3)!(); await tick();
    await expect(batch.promise).resolves.toMatchObject({ succeeded: 4, cancelled: 0 });
  });

  it("retains a paused request durably without starting a source, then freezes canonical intervals", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const handle = interceptChapterDownloadBatch({ jobs: [jobs[3]!, jobs[0]!, jobs[2]!, jobs[1]!], title: "Batch" })!;
    await handle.materialized;
    const snapshot = runtime.getVpnDownloadRuntimeSnapshot();
    expect(snapshot.drafts).toHaveLength(1);
    expect(snapshot.drafts[0]?.selectedChapterIds).toEqual([8, 2, 9, 3]);
    expect(boundary.effects).toEqual(["persist-pending"]);
    await runtime.startVpnDownloadDraft(snapshot.drafts[0]!.id, [
      { startChapterId: 8, endChapterId: 2 },
      { startChapterId: 9, endChapterId: 3 },
    ]);
    await tick();
    const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
    expect(plan.ranges.map(range => range.chapterIds)).toEqual([[8, 2], [9, 3]]);
    expect(boundary.effects.indexOf("publish")).toBeLessThan(boundary.effects.indexOf("connect:0"));
    expect(boundary.effects.indexOf("configure:0")).toBeLessThan(boundary.effects.indexOf("chapter:8:0"));
    expect(boundary.effects).not.toContain("chapter:2:0");
    expect(boundary.jobs.every(job => job.vpnPlanId === plan.id && job.vpnRangeId)).toBe(true);
    boundary.complete.get(8)!(); boundary.complete.get(9)!(); await tick();
    expect(boundary.effects).toContain("chapter:2:0");
    expect(boundary.effects).toContain("chapter:3:1");
    boundary.complete.get(2)!(); boundary.complete.get(3)!(); await tick();
    await expect(handle.promise).resolves.toEqual({ total: 4, succeeded: 4, failed: 0, cancelled: 0 });
  });

  it("refuses overlapping assignments before durable publication", async () => {
    const runtime = await import("./vpn-download-runtime"); await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!; await batch.materialized;
    const id = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id;
    await expect(runtime.startVpnDownloadDraft(id, [
      { startChapterId: 8, endChapterId: 9 },
      { startChapterId: 9, endChapterId: 3 },
    ])).rejects.toThrow(/overlap/i);
    expect(boundary.plans.size).toBe(0); expect(boundary.connect).not.toHaveBeenCalled();
    runtime.cancelVpnDownloadDraft(id); await expect(batch.promise).resolves.toMatchObject({ cancelled: 4 });
  });

  it.each(["off", "off-on", "explicit-off", "draft-cancel", "batch-cancel"] as const)(
    "does not publish a plan or start a worker after %s during a delayed catalog preparation",
    async action => {
      const runtime = await import("./vpn-download-runtime");
      await initializePausedRun(runtime);
      let release!: () => void;
      const lookup = new Promise<void>(resolve => { release = resolve; });
      boundary.catalog.mockImplementationOnce(async () => { await lookup; return catalog; });
      const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
      await batch.materialized;
      const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
      const starting = runtime.startVpnDownloadDraft(draft.id,
        [{ startChapterId: 8, endChapterId: 3 }]);
      await vi.waitFor(() => expect(boundary.catalog).toHaveBeenCalled());

      if (action === "draft-cancel") runtime.cancelVpnDownloadDraft(draft.id);
      else if (action === "batch-cancel") {
        const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
        expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
      } else if (action === "explicit-off") window.dispatchEvent(new Event("norea-plugin-vpn-explicit-off"));
      else {
        useVpnDownloadStore.getState().setMode("off");
        if (action === "off-on") useVpnDownloadStore.getState().setMode("parallel");
      }

      release();
      await starting;
      await tick();
      expect(boundary.effects).toEqual(["persist-pending"]);
      expect(boundary.plans.size).toBe(0);
      expect(boundary.jobs).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
      if (action === "draft-cancel" || action === "batch-cancel") {
        expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
      } else {
        expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([expect.objectContaining({ id: draft.id })]);
        runtime.cancelVpnDownloadDraft(draft.id);
      }
      await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    },
  );

  it.each(["mode", "worker-count"] as const)(
    "revalidates a reduced %s limit after catalog preparation before publishing two ranges",
    async changedSetting => {
      const runtime = await import("./vpn-download-runtime");
      await initializePausedRun(runtime);
      let release!: () => void;
      const lookup = new Promise<void>(resolve => { release = resolve; });
      boundary.catalog.mockImplementationOnce(async () => { await lookup; return catalog; });
      const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
      await batch.materialized;
      const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
      const starting = runtime.startVpnDownloadDraft(draft.id, [
        { startChapterId: 8, endChapterId: 2 },
        { startChapterId: 9, endChapterId: 3 },
      ]);
      const rejected = expect(starting).rejects.toThrow(/worker limit/i);
      await vi.waitFor(() => expect(boundary.catalog).toHaveBeenCalled());
      if (changedSetting === "mode") useVpnDownloadStore.getState().setMode("single");
      else useVpnDownloadStore.getState().setWorkerCount(1);
      release();
      await rejected;
      await tick();
      expect(boundary.effects).toEqual(["persist-pending"]);
      expect(boundary.plans.size).toBe(0);
      expect(boundary.jobs).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([expect.objectContaining({ id: draft.id })]);
      runtime.cancelVpnDownloadDraft(draft.id);
      await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    },
  );

  it.each([["parallel", "single"], ["single", "parallel"]] as const)(
    "retains accepted run policies when live capacity changes from %s to %s",
    async (initialMode, nextMode) => {
      const runtime = await import("./vpn-download-runtime");
      await initializePausedRun(runtime);
      useVpnDownloadStore.getState().setMode(initialMode);
      let release!: () => void;
      const lookup = new Promise<void>(resolve => { release = resolve; });
      boundary.catalog.mockImplementationOnce(async () => { await lookup; return catalog.slice(0, 1); });
      const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
      await batch.materialized;
      const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
      const starting = runtime.startVpnDownloadDraft(draft.id,
        [{ startChapterId: 8, endChapterId: 8 }]);
      await vi.waitFor(() => expect(boundary.catalog).toHaveBeenCalled());
      const settings = useVpnDownloadStore.getState();
      settings.setMode(nextMode);
      settings.setCaptchaPolicy("pause");
      settings.setCloudflarePolicy("nextProfile");
      release();
      await starting;
      await tick();
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]).toMatchObject({
        mode: nextMode, policies: { captcha: "nextProfile", cloudflare: "pause" },
      });
      expect(boundary.connect).toHaveBeenCalledOnce();
      expect(boundary.enqueue.mock.calls.map(([job]) => job.id)).toEqual([8]);
      boundary.complete.get(8)!();
      await tick();
      await expect(batch.promise).resolves.toEqual({ total: 1, succeeded: 1, failed: 0, cancelled: 0 });
    },
  );

  it.each(["batch", "draft"] as const)(
    "preserves %s cancellation across delayed plan publication without starting a worker",
    async target => {
      const runtime = await import("./vpn-download-runtime");
      await initializePausedRun(runtime);
      const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
      await batch.materialized;
      const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
      const create = boundary.createPlan.getMockImplementation()!;
      const remove = boundary.cancelPlan.getMockImplementation()!;
      let publish!: () => void, removePlan!: () => void;
      const publication = new Promise<void>(resolve => { publish = resolve; });
      const deletion = new Promise<void>(resolve => { removePlan = resolve; });
      boundary.createPlan.mockImplementationOnce(async (plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]) => {
        await publication;
        await create(plan, jobs);
      });
      boundary.cancelPlan.mockImplementationOnce(async (id: string) => { await deletion; await remove(id); });
      const starting = runtime.startVpnDownloadDraft(draft.id,
        [{ startChapterId: 8, endChapterId: 3 }]);
      await vi.waitFor(() => expect(boundary.createPlan).toHaveBeenCalledOnce());
      let settled = false;
      void batch.promise.then(() => { settled = true; });
      const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
      for (let attempt = 0; attempt < 2; attempt++) {
        if (target === "batch") expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
        else runtime.cancelVpnDownloadDraft(draft.id);
      }
      await tick();
      expect(settled).toBe(false);
      publish();
      try {
        await tick();
        expect(boundary.connect).not.toHaveBeenCalled();
        expect(boundary.configure).not.toHaveBeenCalled();
        expect(boundary.enqueue).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(boundary.cancelPlan).toHaveBeenCalledOnce());
        expect(boundary.plans.size).toBe(1);
        expect(settled).toBe(false);
      } finally {
        removePlan();
        await starting;
      }
      expect(boundary.plans.size).toBe(0);
      expect(boundary.jobs).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
      await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    },
  );

  it("retries failed cleanup after cancelling a publishing draft without starting its worker", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
    await batch.materialized;
    const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
    const create = boundary.createPlan.getMockImplementation()!;
    let publish!: () => void;
    const publication = new Promise<void>(resolve => { publish = resolve; });
    boundary.createPlan.mockImplementationOnce(async (plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]) => {
      await publication;
      await create(plan, jobs);
    });
    const storageError = new Error("Database deletion failed");
    boundary.cancelPlan.mockRejectedValueOnce(storageError);
    const starting = runtime.startVpnDownloadDraft(draft.id,
      [{ startChapterId: 8, endChapterId: 3 }]);
    const failed = expect(starting).rejects.toBe(storageError);
    await vi.waitFor(() => expect(boundary.createPlan).toHaveBeenCalledOnce());
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
    publish();
    await failed;
    await tick();
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(boundary.enqueue).not.toHaveBeenCalled();
    expect(boundary.plans.size).toBe(1);
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([draft]);
    expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]?.ranges.every(range => range.userPaused)).toBe(true);
    let settled = false;
    void batch.promise.then(() => { settled = true; });
    await expect(runtime.startVpnDownloadDraft(draft.id,
      [{ startChapterId: 8, endChapterId: 3 }])).rejects.toThrow(/starting/i);
    expect(settled).toBe(false);

    runtime.cancelVpnDownloadDraft(draft.id);
    await vi.waitFor(() => expect(boundary.cancelPlan).toHaveBeenCalledTimes(2));
    await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    expect(boundary.createPlan).toHaveBeenCalledOnce();
    expect(boundary.plans.size).toBe(0);
    expect(boundary.jobs).toEqual([]);
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
    expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
    expect(boundary.connect).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "does not materialize a cancelled batch when its delayed catalog query later %ss",
    async outcome => {
      const runtime = await import("./vpn-download-runtime");
      await initializePausedRun(runtime);
      let resolveCatalog!: (value: typeof catalog) => void, rejectCatalog!: (error: Error) => void;
      const query = new Promise<typeof catalog>((resolve, reject) => { resolveCatalog = resolve; rejectCatalog = reject; });
      boundary.catalog.mockReturnValueOnce(query);
      const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
      const materialized = batch.materialized.then(() => undefined, error => error);
      let result: ChapterDownloadBatchResult | undefined;
      void batch.promise.then(value => { result = value; }, () => undefined);
      await vi.waitFor(() => expect(boundary.catalog).toHaveBeenCalledOnce());
      const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
      expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
      await tick();
      const resultBeforeQuerySettles = result;
      if (outcome === "resolve") resolveCatalog(catalog);
      else rejectCatalog(new Error("Late catalog failure"));
      const materializationError = await materialized;

      expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
      expect(materializationError).toBeUndefined();
      expect(resultBeforeQuerySettles).toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
      await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
      expect(runtime.getVpnDownloadRuntimeSnapshot().error).toBeNull();
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
      expect(boundary.effects).toEqual(["persist-pending"]);
      expect(boundary.jobs).toEqual([]);
      expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(false);
    },
  );

  it("cancels a single-pass batch before initialization resumes without querying a catalog", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    const batch = interceptChapterDownloadBatch({ jobs: jobs.values(), total: jobs.length, title: "Batch" })!;
    expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
    await batch.materialized;
    await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    expect(boundary.catalog).not.toHaveBeenCalled();
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
    expect(boundary.effects).toEqual(["persist-pending"]);
  });

  it("keeps a materializing batch pending when another batch publishes and cancels its preview", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    let resolveCatalog!: (value: typeof catalog) => void;
    const query = new Promise<typeof catalog>(resolve => { resolveCatalog = resolve; });
    boundary.catalog.mockReturnValueOnce(query);
    boundary.catalog.mockResolvedValueOnce(catalog.map(chapter => ({ ...chapter, id: chapter.id + 100 })));
    const waiting = interceptChapterDownloadBatch({ jobs, title: "Waiting" })!;
    let waitingResult: ChapterDownloadBatchResult | undefined;
    void waiting.promise.then(value => { waitingResult = value; });
    await vi.waitFor(() => expect(boundary.catalog).toHaveBeenCalledOnce());
    const ready = interceptChapterDownloadBatch({ jobs: jobs.map(job => ({ ...job, id: job.id + 100, novelId: 20, chapterPath: `${job.chapterPath}-other` })), title: "Ready" })!;
    await ready.materialized;
    const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts.find(draft => draft.batchId === ready.id)!;
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    try {
      await tick();
      expect(waitingResult).toBeUndefined();
      runtime.cancelVpnDownloadDraft(draft.id);
      await expect(ready.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
      expect(waitingResult).toBeUndefined();
      expect(cancelInterceptedChapterDownloadBatch(waiting.id)).toBe(true);
      await expect(waiting.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    } finally {
      runtime.cancelVpnDownloadDraft(draft.id);
      cancelInterceptedChapterDownloadBatch(waiting.id);
      resolveCatalog(catalog);
      await waiting.materialized;
    }
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
    expect(boundary.effects).toEqual(["persist-pending", "persist-pending"]);
  });

  it.each([
    { completed: [8, 9], waiting: [2, 3], succeeded: 2, cancelled: 2, heldSlot: 0 },
    { completed: [8, 2, 9], waiting: [3], succeeded: 3, cancelled: 1, heldSlot: 1 },
  ])("preserves $succeeded completed chapters on batch cancellation and waits for worker cleanup", async value => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [
      { startChapterId: 8, endChapterId: 2 },
      { startChapterId: 9, endChapterId: 3 },
    ]);
    for (const id of value.completed) {
      await vi.waitFor(() => expect(boundary.complete.has(id)).toBe(true));
      boundary.complete.get(id)!(); await tick();
    }
    await vi.waitFor(() => expect(value.waiting.every(id => boundary.complete.has(id))).toBe(true));
    const worker: VpnDownloadWorkerRef = boundary.enqueue.mock.calls.map(([, worker]) => worker).find(worker => worker.slot === value.heldSlot)!;
    const contexts = await import("./vpn-worker-context");
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    boundary.close.mockImplementation(async worker => { if (worker.slot === value.heldSlot) await cleanup; });
    let result: ChapterDownloadBatchResult | undefined;
    void batch.promise.then(value => { result = value; });
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
    expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
    try {
      await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledTimes(2));
      expect(result).toBeUndefined();
      expect(boundary.cancelPlan).not.toHaveBeenCalled();
      expect(contexts.getVpnDownloadWorkerContext(`vpn:${worker.slot}:${worker.generation}`)).toEqual(worker);
    } finally { release(); }
    await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: value.succeeded, failed: 0, cancelled: value.cancelled });
    expect(boundary.enqueue.mock.calls.map(([job]) => job.id).sort()).toEqual([2, 3, 8, 9]);
    expect(boundary.disconnect).toHaveBeenCalledTimes(2);
    expect(contexts.getVpnDownloadWorkerContext(`vpn:${worker.slot}:${worker.generation}`)).toBeUndefined();
    expect(boundary.plans.size).toBe(0);
    expect(boundary.jobs).toEqual([]);
    expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
  });

  it("keeps a completed batch active until its final worker has closed and released its executor", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(boundary.complete.has(8)).toBe(true));
    const worker: VpnDownloadWorkerRef = boundary.enqueue.mock.calls[0]![1];
    const contexts = await import("./vpn-worker-context");
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    boundary.close.mockImplementationOnce(async () => { await cleanup; });
    let result: ChapterDownloadBatchResult | undefined;
    void batch.promise.then(value => { result = value; });
    boundary.complete.get(8)!();
    try {
      await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledOnce());
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]?.ranges[0]).toMatchObject({ phase: "completed", checkpoint: 1 });
      expect(result).toBeUndefined();
      expect(contexts.getVpnDownloadWorkerContext(`vpn:${worker.slot}:${worker.generation}`)).toEqual(worker);
    } finally { release(); }
    await expect(batch.promise).resolves.toEqual({ total: 1, succeeded: 1, failed: 0, cancelled: 0 });
    expect(contexts.getVpnDownloadWorkerContext(`vpn:${worker.slot}:${worker.generation}`)).toBeUndefined();
    expect(boundary.disconnect).toHaveBeenCalledOnce();
    expect(boundary.jobs).toEqual([]);
  });

  it("retains completed results from one work while cancelling another plan in the same batch", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs: jobs.map(job => ({ ...job, novelId: job.id === 9 || job.id === 3 ? 20 : 10 })), title: "Batch" })!;
    await batch.materialized;
    const drafts = runtime.getVpnDownloadRuntimeSnapshot().drafts;
    const first = drafts.find(draft => draft.novelId === 10)!;
    const second = drafts.find(draft => draft.novelId === 20)!;
    await runtime.startVpnDownloadDraft(first.id, [{ startChapterId: 8, endChapterId: 2 }]);
    await runtime.startVpnDownloadDraft(second.id, [{ startChapterId: 9, endChapterId: 3 }]);
    await vi.waitFor(() => expect(boundary.complete.has(8) && boundary.complete.has(9)).toBe(true));
    boundary.complete.get(8)!();
    await vi.waitFor(() => expect(boundary.complete.has(2)).toBe(true));
    boundary.complete.get(2)!();
    await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledOnce());
    boundary.complete.get(9)!();
    await vi.waitFor(() => expect(boundary.complete.has(3)).toBe(true));
    let result: ChapterDownloadBatchResult | undefined;
    void batch.promise.then(value => { result = value; });
    await tick();
    expect(result).toBeUndefined();
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
    await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 3, failed: 0, cancelled: 1 });
    expect(boundary.cancelPlan).toHaveBeenCalledTimes(2);
    expect(boundary.plans.size).toBe(0);
    expect(boundary.jobs).toEqual([]);
    expect(boundary.close).toHaveBeenCalledTimes(2);
    expect(boundary.disconnect).toHaveBeenCalledTimes(2);
  });

  it.each([
    { mode: "parallel" as const, workerCount: 1 },
    { mode: "single" as const, workerCount: 2 },
  ])("shares one connection across separate plans in $mode mode with count $workerCount", async settings => {
    useVpnDownloadStore.setState(settings);
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const first = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "First" })!;
    const second = interceptChapterDownloadBatch({ jobs: [{ ...jobs[2]!, novelId: 20 }], title: "Second" })!;
    await Promise.all([first.materialized, second.materialized]);
    const drafts = runtime.getVpnDownloadRuntimeSnapshot().drafts;
    await runtime.startVpnDownloadDraft(drafts.find(draft => draft.batchId === first.id)!.id,
      [{ startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(boundary.complete.has(8)).toBe(true));
    await runtime.startVpnDownloadDraft(drafts.find(draft => draft.batchId === second.id)!.id,
      [{ startChapterId: 9, endChapterId: 9 }]);
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    boundary.close.mockImplementationOnce(async () => { await cleanup; });
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    try {
      await tick();
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toHaveLength(2);
      expect(boundary.connect).toHaveBeenCalledOnce();
      expect(boundary.enqueue.mock.calls.map(([job]) => job.id)).toEqual([8]);
      boundary.complete.get(8)!();
      await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledOnce());
      expect(boundary.connect).toHaveBeenCalledOnce();
      expect(boundary.complete.has(9)).toBe(false);
      release();
      await expect(first.promise).resolves.toEqual({ total: 1, succeeded: 1, failed: 0, cancelled: 0 });
      await vi.waitFor(() => expect(boundary.complete.has(9)).toBe(true));
      expect(boundary.connect.mock.calls.map(([worker, profile]) => [worker.slot, profile.id])).toEqual([[0, "profile-a"], [0, "profile-a"]]);
      expect(boundary.enqueue.mock.calls.map(([job]) => job.id)).toEqual([8, 9]);
      boundary.complete.get(9)!();
      await expect(second.promise).resolves.toEqual({ total: 1, succeeded: 1, failed: 0, cancelled: 0 });
      expect(boundary.disconnect).toHaveBeenCalledTimes(2);
      expect(boundary.jobs).toEqual([]);
    } finally {
      release();
      cancelInterceptedChapterDownloadBatch(first.id);
      cancelInterceptedChapterDownloadBatch(second.id);
      await tick();
    }
  });

  it("counts a connecting worker against the global limit and wakes a waiting plan when the limit increases", async () => {
    useVpnDownloadStore.setState({ workerCount: 1 });
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const first = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "First" })!;
    const second = interceptChapterDownloadBatch({ jobs: [{ ...jobs[2]!, novelId: 20 }], title: "Second" })!;
    await Promise.all([first.materialized, second.materialized]);
    const drafts = runtime.getVpnDownloadRuntimeSnapshot().drafts;
    const connect = boundary.connect.getMockImplementation()!;
    let release!: () => void;
    const connection = new Promise<void>(resolve => { release = resolve; });
    boundary.connect.mockImplementationOnce(async (worker, profile) => { await connection; return connect(worker, profile); });
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    try {
      await runtime.startVpnDownloadDraft(drafts.find(draft => draft.batchId === first.id)!.id,
        [{ startChapterId: 8, endChapterId: 8 }]);
      await vi.waitFor(() => expect(boundary.connect).toHaveBeenCalledOnce());
      await runtime.startVpnDownloadDraft(drafts.find(draft => draft.batchId === second.id)!.id,
        [{ startChapterId: 9, endChapterId: 9 }]);
      await tick();
      expect(boundary.connect).toHaveBeenCalledOnce();
      expect(boundary.enqueue).not.toHaveBeenCalled();
      useVpnDownloadStore.getState().setWorkerCount(2);
      await vi.waitFor(() => expect(boundary.complete.has(9)).toBe(true));
      expect(boundary.complete.has(8)).toBe(false);
      expect(boundary.connect.mock.calls.map(([worker]) => worker.slot)).toEqual([0, 1]);
      release();
      await vi.waitFor(() => expect(boundary.complete.has(8)).toBe(true));
      boundary.complete.get(8)!(); boundary.complete.get(9)!();
      await expect(Promise.all([first.promise, second.promise])).resolves.toEqual([
        { total: 1, succeeded: 1, failed: 0, cancelled: 0 },
        { total: 1, succeeded: 1, failed: 0, cancelled: 0 },
      ]);
    } finally {
      release();
      cancelInterceptedChapterDownloadBatch(first.id);
      cancelInterceptedChapterDownloadBatch(second.id);
      await tick();
    }
  });

  it.each(["worker-count", "mode"] as const)("honors a reduced %s while an accepted two-range plan is being published", async setting => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
    await batch.materialized;
    const create = boundary.createPlan.getMockImplementation()!;
    let release!: () => void;
    const publication = new Promise<void>(resolve => { release = resolve; });
    boundary.createPlan.mockImplementationOnce(async (plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]) => {
      await publication; await create(plan, jobs);
    });
    const starting = runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [
      { startChapterId: 8, endChapterId: 2 },
      { startChapterId: 9, endChapterId: 3 },
    ]);
    await vi.waitFor(() => expect(boundary.createPlan).toHaveBeenCalledOnce());
    if (setting === "mode") useVpnDownloadStore.getState().setMode("single");
    else useVpnDownloadStore.getState().setWorkerCount(1);
    release();
    await starting;
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    try {
      await vi.waitFor(() => expect(boundary.complete.has(8)).toBe(true));
      expect(boundary.connect).toHaveBeenCalledOnce();
      expect(boundary.complete.has(9)).toBe(false);
      const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
      expect(plan.mode).toBe("parallel");
      expect(plan.ranges.map(range => range.selectedChapterIds)).toEqual([[8, 2], [9, 3]]);
      for (const id of [8, 2, 9, 3]) {
        await vi.waitFor(() => expect(boundary.complete.has(id)).toBe(true));
        boundary.complete.get(id)!();
      }
      await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 4, failed: 0, cancelled: 0 });
      expect(boundary.connect.mock.calls.map(([worker]) => worker.slot)).toEqual([0, 0]);
      expect(boundary.enqueue.mock.calls.map(([job]) => job.id)).toEqual([8, 2, 9, 3]);
    } finally { cancelInterceptedChapterDownloadBatch(batch.id); await tick(); }
  });

  it.each(["worker-count", "mode"] as const)("applies a reduced %s across live plans at chapter boundaries", async setting => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs: jobs.map(job => ({ ...job, novelId: job.id === 9 || job.id === 3 ? 20 : 10 })), title: "Batch" })!;
    await batch.materialized;
    const drafts = runtime.getVpnDownloadRuntimeSnapshot().drafts;
    await runtime.startVpnDownloadDraft(drafts.find(draft => draft.novelId === 10)!.id,
      [{ startChapterId: 8, endChapterId: 2 }]);
    await runtime.startVpnDownloadDraft(drafts.find(draft => draft.novelId === 20)!.id,
      [{ startChapterId: 9, endChapterId: 3 }]);
    await vi.waitFor(() => expect(boundary.complete.has(8) && boundary.complete.has(9)).toBe(true));
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    try {
      if (setting === "mode") useVpnDownloadStore.getState().setMode("single");
      else useVpnDownloadStore.getState().setWorkerCount(1);
      expect(boundary.cancelTask).not.toHaveBeenCalled();
      expect(boundary.close).not.toHaveBeenCalled();
      boundary.complete.get(9)!();
      await tick();
      expect(boundary.complete.has(3)).toBe(false);
      await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledOnce());
      expect(boundary.close.mock.calls[0]![0]).toMatchObject({ slot: 1 });
      expect(boundary.connect).toHaveBeenCalledTimes(2);
      boundary.complete.get(8)!();
      await vi.waitFor(() => expect(boundary.complete.has(2)).toBe(true));
      expect(boundary.complete.has(3)).toBe(false);
      boundary.complete.get(2)!();
      await vi.waitFor(() => expect(boundary.complete.has(3)).toBe(true));
      expect(boundary.connect.mock.calls.map(([worker, profile]) => [worker.slot, profile.id])).toEqual([
        [0, "profile-a"], [1, "profile-b"], [0, "profile-b"],
      ]);
      expect(boundary.enqueue.mock.calls.map(([job]) => job.id)).toEqual([8, 9, 2, 3]);
      boundary.complete.get(3)!();
      await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 4, failed: 0, cancelled: 0 });
      expect(boundary.cancelTask).not.toHaveBeenCalled();
      expect(boundary.jobs).toEqual([]);
    } finally { cancelInterceptedChapterDownloadBatch(batch.id); await tick(); }
  });

  it("settles running tasks, both worker browsers and native tunnels before restore locks or settings changes", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [
      { startChapterId: 8, endChapterId: 2 },
      { startChapterId: 9, endChapterId: 3 },
    ]);
    await vi.waitFor(() => expect(boundary.complete.has(8) && boundary.complete.has(9)).toBe(true));
    let settleTask!: () => void, closeBrowser!: () => void, disconnectTunnel!: () => void, stopNative!: () => void;
    const taskGate = new Promise<void>(resolve => { settleTask = resolve; });
    const browserGate = new Promise<void>(resolve => { closeBrowser = resolve; });
    const tunnelGate = new Promise<void>(resolve => { disconnectTunnel = resolve; });
    const nativeGate = new Promise<void>(resolve => { stopNative = resolve; });
    boundary.settleTask.mockImplementation(async id => { if (id === "task:8") await taskGate; });
    boundary.close.mockImplementation(async worker => { if (worker.slot === 1) await browserGate; });
    boundary.disconnect.mockImplementation(async worker => { if (worker.slot === 0) await tunnelGate; return { phase: "disabled" }; });
    boundary.stop.mockImplementationOnce(async () => { await nativeGate; });
    installBackupFixture();
    const backup = await import("../content-sync/device-backup");
    const previous = backup.readDeviceSettings();
    const reload = new Error("Test reload boundary");
    const restoring = backup.restoreDeviceBackup("http://backup.test", backupEntry, undefined, () => { throw reload; });
    const finished = expect(restoring).rejects.toBe(reload);
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    try {
      await tick();
      expect(boundary.restoreEffects).toEqual([]);
      expect(backup.readDeviceSettings()).toEqual(previous);
      expect(boundary.cancelTask).toHaveBeenCalledTimes(2);
      expect(boundary.close.mock.calls.map(([worker]) => worker.slot)).toEqual([1]);
      expect(() => interceptChapterDownloadBatch({ jobs: [jobs[1]!], title: "Late" })).toThrow(/restore/i);
      const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
      await expect(runtime.resumeVpnDownloadRange(plan.id, plan.ranges[0]!.id)).rejects.toThrow(/restore/i);
      settleTask();
      await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledTimes(2));
      expect(boundary.restoreEffects).toEqual([]);
      closeBrowser();
      await tick();
      expect(boundary.restoreEffects).toEqual([]);
      disconnectTunnel();
      await vi.waitFor(() => expect(boundary.stop).toHaveBeenCalledOnce());
      expect(boundary.restoreEffects).toEqual([]);
      expect(backup.readDeviceSettings()).toEqual(previous);
      stopNative();
      await finished;
      expect(boundary.restoreEffects).toEqual(["sync-lock", "storage-lock", "database-open", "database-lock", "metadata-stop", "native-restore"]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.every(range => range.phase === "paused" && !range.userPaused)).toBe(true);
      expect(boundary.enqueue.mock.calls.map(([job]) => job.id)).toEqual([8, 9]);
    } finally {
      settleTask(); closeBrowser(); disconnectTunnel(); stopNative();
      await finished;
      cancelInterceptedChapterDownloadBatch(batch.id);
      await tick();
    }
  });

  it("waits for an already completed worker's pending close before restore acquires barriers", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(boundary.complete.has(8)).toBe(true));
    let close!: () => void;
    const browser = new Promise<void>(resolve => { close = resolve; });
    boundary.close.mockImplementationOnce(async () => { await browser; });
    boundary.complete.get(8)!();
    await vi.waitFor(() => expect(boundary.close).toHaveBeenCalledOnce());
    installBackupFixture();
    const backup = await import("../content-sync/device-backup");
    const reload = new Error("Test reload boundary");
    const finished = expect(backup.restoreDeviceBackup("http://backup.test", backupEntry, undefined, () => { throw reload; })).rejects.toBe(reload);
    try {
      await tick();
      expect(boundary.restoreEffects).toEqual([]);
      expect(boundary.stop).not.toHaveBeenCalled();
    } finally { close(); await finished; }
    await expect(batch.promise).resolves.toMatchObject({ succeeded: 1 });
    expect(boundary.restoreEffects).toContain("native-restore");
  });

  it("waits for a pending plan write to become paused before restore can replace its database", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    const create = boundary.createPlan.getMockImplementation()!;
    let publish!: () => void;
    const publication = new Promise<void>(resolve => { publish = resolve; });
    boundary.createPlan.mockImplementationOnce(async (plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]) => {
      await publication; await create(plan, jobs);
    });
    const starting = runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(boundary.createPlan).toHaveBeenCalledOnce());
    installBackupFixture();
    const backup = await import("../content-sync/device-backup");
    const reload = new Error("Test reload boundary");
    const finished = expect(backup.restoreDeviceBackup("http://backup.test", backupEntry, undefined, () => { throw reload; })).rejects.toBe(reload);
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    try {
      await tick();
      expect(boundary.restoreEffects).toEqual([]);
      publish(); await starting; await finished;
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]).toMatchObject({ phase: "paused", userPaused: false });
      expect(boundary.connect).not.toHaveBeenCalled();
      expect(boundary.restoreEffects).toContain("native-restore");
    } finally { publish(); await starting; await finished; cancelInterceptedChapterDownloadBatch(batch.id); await tick(); }
  });

  it("refuses restore without taking barriers when native worker settlement fails and allows explicit resume afterward", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(boundary.complete.has(8)).toBe(true));
    const failure = new Error("VPN worker cleanup monitor closed; lease retained");
    boundary.stop.mockRejectedValueOnce(failure);
    installBackupFixture();
    const backup = await import("../content-sync/device-backup");
    const previous = backup.readDeviceSettings();
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    try {
      await expect(backup.restoreDeviceBackup("http://backup.test", backupEntry, undefined,
        () => { throw new Error("Unexpected reload"); })).rejects.toBe(failure);
      expect(boundary.restoreEffects).toEqual([]);
      expect(backup.readDeviceSettings()).toEqual(previous);
      expect(boundary.invoke).toHaveBeenCalledWith("device_backup_cleanup", { path: backupFile.path });
      const plan = runtime.getVpnDownloadRuntimeSnapshot().plans[0]!;
      expect(plan.ranges[0]).toMatchObject({ phase: "paused", userPaused: false });
      expect(boundary.connect).toHaveBeenCalledOnce();
      await runtime.resumeVpnDownloadRange(plan.id, plan.ranges[0]!.id);
      await vi.waitFor(() => expect(boundary.connect).toHaveBeenCalledTimes(2));
    } finally { cancelInterceptedChapterDownloadBatch(batch.id); await tick(); }
  });

  it("invalidates a delayed catalog preparation so it cannot publish a new worker behind the restore hold", async () => {
    const runtime = await import("./vpn-download-runtime");
    await initializePausedRun(runtime);
    let profilesReady!: () => void, workersStopped!: () => void;
    const lookup = new Promise<void>(resolve => { profilesReady = resolve; });
    const nativeStop = new Promise<void>(resolve => { workersStopped = resolve; });
    boundary.catalog.mockImplementationOnce(async () => { await lookup; return catalog.slice(0, 1); });
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
    boundary.stop.mockImplementationOnce(async () => { await nativeStop; });
    const assignments = [{ startChapterId: 8, endChapterId: 8 }];
    const starting = runtime.startVpnDownloadDraft(draft.id, assignments);
    await vi.waitFor(() => expect(boundary.catalog).toHaveBeenCalled());
    installBackupFixture();
    const backup = await import("../content-sync/device-backup");
    const reload = new Error("Test reload boundary");
    const finished = expect(backup.restoreDeviceBackup("http://backup.test", backupEntry, undefined, () => { throw reload; })).rejects.toBe(reload);
    try {
      await vi.waitFor(() => expect(boundary.stop).toHaveBeenCalledOnce());
      profilesReady(); await starting; await tick();
      expect(boundary.plans.size).toBe(0);
      expect(boundary.connect).not.toHaveBeenCalled();
      expect(boundary.restoreEffects).toEqual([]);
      await expect(runtime.startVpnDownloadDraft(draft.id, assignments)).rejects.toThrow(/restore/i);
    } finally {
      profilesReady(); workersStopped(); await starting; await finished;
      runtime.cancelVpnDownloadDraft(draft.id);
    }
    await expect(batch.promise).resolves.toEqual({ total: 1, succeeded: 0, failed: 0, cancelled: 1 });
  });

  it("does not bypass unsupported workers or silently fall back to ordinary downloads", async () => {
    window.__NoreaAndroidVpnWorkers!.capabilities = () => "{}";
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    expect(runtime.getVpnDownloadRuntimeSnapshot().capabilities.supported).toBe(false);
    await expect(runtime.startVpnDownloadRun({ workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile" })).rejects.toThrow(/support/i);
    expect(boundary.connect).not.toHaveBeenCalled();
  });

  it("preserves the ordinary batch path when automatic mode is off", async () => {
    useVpnDownloadStore.setState({ mode: "off" });
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    expect(interceptChapterDownloadBatch({ jobs, title: "Batch" })).toBeNull();
    expect(boundary.catalog).not.toHaveBeenCalled();
  });

  it("keeps snapshots stable without changes and releases only the completed worker context", async () => {
    const runtime = await import("./vpn-download-runtime"); await initializePausedRun(runtime);
    expect(runtime.getVpnDownloadRuntimeSnapshot()).toBe(runtime.getVpnDownloadRuntimeSnapshot());
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!; await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ startChapterId: 8, endChapterId: 8 }]); await tick();
    const ref = boundary.enqueue.mock.calls[0]![1];
    const contexts = await import("./vpn-worker-context");
    expect(contexts.getVpnDownloadWorkerContext(`vpn:0:${ref.generation}`)).toEqual(ref);
    boundary.complete.get(8)!(); await tick(); await batch.promise;
    expect(contexts.getVpnDownloadWorkerContext(`vpn:0:${ref.generation}`)).toBeUndefined();
    expect(boundary.close).toHaveBeenCalledWith(ref, "source-test");
    expect(boundary.disconnect).toHaveBeenCalledWith(ref);
  });
});
