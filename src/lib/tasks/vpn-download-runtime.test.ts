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
  profiles: vi.fn(), status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
  stop: vi.fn(), restart: vi.fn(), createPlan: vi.fn(), cancelPlan: vi.fn(), cancelTask: vi.fn(),
  settleTask: vi.fn(), restoreEffects: [] as string[],
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
vi.mock("../../db/queries/chapter", () => ({ listChaptersByNovel: boundary.catalog }));
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
vi.mock("../plugin-vpn", () => ({ getPluginVpnStatus: boundary.status }));
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
  enqueueVpnDownloadChapter: boundary.enqueue,
  publishVpnDownloadBatchProgress: vi.fn(),
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
  vi.resetModules(); vi.clearAllMocks(); boundary.plans.clear(); boundary.jobs = []; boundary.effects = []; boundary.complete.clear(); boundary.reject.clear();
  boundary.restoreEffects = []; boundary.issues = []; boundary.blocks = []; boundary.listeners.clear();
  const settings = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return settings.size; }, key: (index: number) => [...settings.keys()][index] ?? null,
    getItem: (key: string) => settings.get(key) ?? null, setItem: (key: string, value: string) => { settings.set(key, value); },
    removeItem: (key: string) => { settings.delete(key); }, clear: () => { settings.clear(); },
  });
  vi.stubGlobal("window", new EventTarget());
  Object.assign(window, { localStorage });
  ({ useVpnDownloadStore } = await import("../../store/vpn-download"));
  ({ interceptChapterDownloadBatch } = await import("./chapter-download-batch-interceptor"));
  Object.assign(window, { __NoreaAndroidVpnWorkers: { capabilities: () => JSON.stringify({ supported: true, parallelSupported: true, maxWorkers: 2 }) } });
  boundary.catalog.mockResolvedValue(catalog);
  boundary.createPlan.mockImplementation(async (plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]) => {
    boundary.effects.push("publish"); boundary.plans.set(plan.id, structuredClone(plan)); boundary.jobs.push(...jobs);
  });
  boundary.cancelPlan.mockImplementation(async (id: string) => {
    boundary.plans.delete(id); boundary.jobs = boundary.jobs.filter(job => job.vpnPlanId !== id);
  });
  boundary.profiles.mockResolvedValue({ limit: 20, profiles, cleanupError: null });
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

describe("VPN download production integration", () => {
  it("resumes an exhausted batch when the shared profile mutation boundary publishes a new healthy O file", async () => {
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: [profiles[0]!], cleanupError: null });
    boundary.connect.mockImplementation(async (worker, profile) => {
      if (profile.id === "profile-a") throw Object.assign(new Error("Tunnel refused"), { code: "plugin-vpn-unavailable" });
      return { supported: true, worker, phase: "connected", profile: profiles[1], proxyPort: 12000 + worker.slot, error: null };
    });
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!; await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]?.pauseReason).toBe("profiles-exhausted"));
    boundary.profiles.mockResolvedValue({ limit: 20, profiles, cleanupError: null });
    window.dispatchEvent(new Event("norea-vpn-profiles-changed"));
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]?.profileId).toBe("profile-b");
    boundary.complete.get(8)!(); await tick(); await expect(batch.promise).resolves.toMatchObject({ succeeded: 1 });
  });
  it("rejects a foreground-occupied IP variant before publication without excluding it", async () => {
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    boundary.status.mockResolvedValue({ phase: "connected", profile: { hash: "udp-variant", remoteHost: profiles[0]!.ip, isVpnGateFinder: true }, supported: true, proxyPort: 123, error: null });
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!; await batch.materialized;
    const draftId = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id;
    await expect(runtime.startVpnDownloadDraft(draftId, [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }])).rejects.toThrow(/profile/i);
    await tick();
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
    expect(boundary.issues).toEqual([]);
    boundary.status.mockResolvedValue({ phase: "disabled", profile: null, supported: true, proxyPort: 123, error: null });
    await runtime.startVpnDownloadDraft(draftId, [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(boundary.enqueue).toHaveBeenCalledTimes(1));
    boundary.complete.get(8)!(); await tick(); await expect(batch.promise).resolves.toMatchObject({ succeeded: 1 });
  });

  it("can retry a failed browser close and finish cancellation without adopting a cached rejection", async () => {
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!; await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
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
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    const pool = [...profiles, { ...profiles[0]!, id: "profile-c", hash: "hash-c", ip: "192.0.2.3" }];
    boundary.profiles.mockResolvedValue({ limit: 20, profiles: pool, cleanupError: null });
    boundary.connect.mockImplementation(async (worker, profile) => {
      boundary.effects.push(`connect:${worker.slot}`);
      return { supported: true, worker, phase: "connected", profile: pool.find(candidate => candidate.id === profile.id), proxyPort: 12000 + worker.slot, error: null };
    });
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!; await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [
      { profileId: "profile-a", startChapterId: 8, endChapterId: 2 },
      { profileId: "profile-b", startChapterId: 9, endChapterId: 3 },
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

  it("previews a batch without persisting jobs or starting a source, then freezes canonical intervals", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.initializeVpnDownloadRuntime();
    const handle = interceptChapterDownloadBatch({ jobs: [jobs[3]!, jobs[0]!, jobs[2]!, jobs[1]!], title: "Batch" })!;
    await handle.materialized;
    const snapshot = runtime.getVpnDownloadRuntimeSnapshot();
    expect(snapshot.drafts).toHaveLength(1);
    expect(snapshot.drafts[0]?.selectedChapterIds).toEqual([8, 2, 9, 3]);
    expect(boundary.effects).toEqual([]);
    await runtime.startVpnDownloadDraft(snapshot.drafts[0]!.id, [
      { profileId: "profile-a", startChapterId: 8, endChapterId: 2 },
      { profileId: "profile-b", startChapterId: 9, endChapterId: 3 },
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

  it("refuses unavailable profiles and overlapping assignments before durable publication", async () => {
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!; await batch.materialized;
    const id = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id;
    await expect(runtime.startVpnDownloadDraft(id, [{ profileId: "missing", startChapterId: 8, endChapterId: 3 }])).rejects.toThrow(/profile/i);
    await expect(runtime.startVpnDownloadDraft(id, [
      { profileId: "profile-a", startChapterId: 8, endChapterId: 9 },
      { profileId: "profile-b", startChapterId: 9, endChapterId: 3 },
    ])).rejects.toThrow(/overlap/i);
    expect(boundary.plans.size).toBe(0); expect(boundary.connect).not.toHaveBeenCalled();
    runtime.cancelVpnDownloadDraft(id); await expect(batch.promise).resolves.toMatchObject({ cancelled: 4 });
  });

  it.each(["off", "off-on", "explicit-off", "draft-cancel", "batch-cancel"] as const)(
    "does not publish a plan or start a worker after %s during a delayed profile lookup",
    async action => {
      const runtime = await import("./vpn-download-runtime");
      await runtime.initializeVpnDownloadRuntime();
      const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
      await batch.materialized;
      const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
      let release!: () => void;
      const lookup = new Promise<void>(resolve => { release = resolve; });
      boundary.profiles.mockImplementationOnce(async () => {
        await lookup;
        return { limit: 20, profiles, cleanupError: null };
      });
      const starting = runtime.startVpnDownloadDraft(draft.id,
        [{ profileId: "profile-a", startChapterId: 8, endChapterId: 3 }]);
      await vi.waitFor(() => expect(boundary.profiles).toHaveBeenCalledOnce());

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
      expect(boundary.effects).toEqual([]);
      expect(boundary.plans.size).toBe(0);
      expect(boundary.jobs).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
      if (action === "draft-cancel" || action === "batch-cancel") {
        expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
      } else {
        expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([draft]);
        runtime.cancelVpnDownloadDraft(draft.id);
      }
      await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    },
  );

  it.each(["mode", "worker-count"] as const)(
    "revalidates a reduced %s limit after the profile lookup before publishing two ranges",
    async changedSetting => {
      const runtime = await import("./vpn-download-runtime");
      await runtime.initializeVpnDownloadRuntime();
      const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
      await batch.materialized;
      const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
      let release!: () => void;
      const lookup = new Promise<void>(resolve => { release = resolve; });
      boundary.profiles.mockImplementationOnce(async () => {
        await lookup;
        return { limit: 20, profiles, cleanupError: null };
      });
      const starting = runtime.startVpnDownloadDraft(draft.id, [
        { profileId: "profile-a", startChapterId: 8, endChapterId: 2 },
        { profileId: "profile-b", startChapterId: 9, endChapterId: 3 },
      ]);
      const rejected = expect(starting).rejects.toThrow(/worker limit/i);
      await vi.waitFor(() => expect(boundary.profiles).toHaveBeenCalledOnce());
      if (changedSetting === "mode") useVpnDownloadStore.getState().setMode("single");
      else useVpnDownloadStore.getState().setWorkerCount(1);
      release();
      await rejected;
      await tick();
      expect(boundary.effects).toEqual([]);
      expect(boundary.plans.size).toBe(0);
      expect(boundary.jobs).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans).toEqual([]);
      expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([draft]);
      runtime.cancelVpnDownloadDraft(draft.id);
      await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    },
  );

  it.each([["parallel", "single"], ["single", "parallel"]] as const)(
    "uses the latest mode and policies for a valid one-range start after %s changes to %s",
    async (initialMode, nextMode) => {
      const runtime = await import("./vpn-download-runtime");
      await runtime.initializeVpnDownloadRuntime();
      useVpnDownloadStore.getState().setMode(initialMode);
      const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
      await batch.materialized;
      const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
      let release!: () => void;
      const lookup = new Promise<void>(resolve => { release = resolve; });
      boundary.profiles.mockImplementationOnce(async () => {
        await lookup;
        return { limit: 20, profiles, cleanupError: null };
      });
      const starting = runtime.startVpnDownloadDraft(draft.id,
        [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
      await vi.waitFor(() => expect(boundary.profiles).toHaveBeenCalledOnce());
      const settings = useVpnDownloadStore.getState();
      settings.setMode(nextMode);
      settings.setCaptchaPolicy("pause");
      settings.setCloudflarePolicy("nextProfile");
      release();
      await starting;
      await tick();
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]).toMatchObject({
        mode: nextMode, policies: { captcha: "pause", cloudflare: "nextProfile" },
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
      await runtime.initializeVpnDownloadRuntime();
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
        [{ profileId: "profile-a", startChapterId: 8, endChapterId: 3 }]);
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
    await runtime.initializeVpnDownloadRuntime();
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
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 3 }]);
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
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 3 }])).rejects.toThrow(/starting/i);
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
      await runtime.initializeVpnDownloadRuntime();
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
      expect(boundary.effects).toEqual([]);
      expect(boundary.jobs).toEqual([]);
      expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(false);
    },
  );

  it("cancels a single-pass batch before initialization resumes without querying a catalog", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.initializeVpnDownloadRuntime();
    const { cancelInterceptedChapterDownloadBatch } = await import("./chapter-download-batch-interceptor");
    const batch = interceptChapterDownloadBatch({ jobs: jobs.values(), total: jobs.length, title: "Batch" })!;
    expect(cancelInterceptedChapterDownloadBatch(batch.id)).toBe(true);
    await batch.materialized;
    await expect(batch.promise).resolves.toEqual({ total: 4, succeeded: 0, failed: 0, cancelled: 4 });
    expect(boundary.catalog).not.toHaveBeenCalled();
    expect(runtime.getVpnDownloadRuntimeSnapshot().drafts).toEqual([]);
    expect(boundary.effects).toEqual([]);
  });

  it("keeps a materializing batch pending when another batch publishes and cancels its preview", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.initializeVpnDownloadRuntime();
    let resolveCatalog!: (value: typeof catalog) => void;
    const query = new Promise<typeof catalog>(resolve => { resolveCatalog = resolve; });
    boundary.catalog.mockReturnValueOnce(query);
    const waiting = interceptChapterDownloadBatch({ jobs, title: "Waiting" })!;
    let waitingResult: ChapterDownloadBatchResult | undefined;
    void waiting.promise.then(value => { waitingResult = value; });
    await vi.waitFor(() => expect(boundary.catalog).toHaveBeenCalledOnce());
    const ready = interceptChapterDownloadBatch({ jobs, title: "Ready" })!;
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
    expect(boundary.effects).toEqual([]);
  });

  it.each([
    { completed: [8, 9], waiting: [2, 3], succeeded: 2, cancelled: 2, heldSlot: 0 },
    { completed: [8, 2, 9], waiting: [3], succeeded: 3, cancelled: 1, heldSlot: 1 },
  ])("preserves $succeeded completed chapters on batch cancellation and waits for worker cleanup", async value => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [
      { profileId: "profile-a", startChapterId: 8, endChapterId: 2 },
      { profileId: "profile-b", startChapterId: 9, endChapterId: 3 },
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
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
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
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs: jobs.map(job => ({ ...job, novelId: job.id === 9 || job.id === 3 ? 20 : 10 })), title: "Batch" })!;
    await batch.materialized;
    const drafts = runtime.getVpnDownloadRuntimeSnapshot().drafts;
    const first = drafts.find(draft => draft.novelId === 10)!;
    const second = drafts.find(draft => draft.novelId === 20)!;
    await runtime.startVpnDownloadDraft(first.id, [{ profileId: "profile-a", startChapterId: 8, endChapterId: 2 }]);
    await runtime.startVpnDownloadDraft(second.id, [{ profileId: "profile-b", startChapterId: 9, endChapterId: 3 }]);
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
    await runtime.initializeVpnDownloadRuntime();
    const first = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "First" })!;
    const second = interceptChapterDownloadBatch({ jobs: [{ ...jobs[2]!, novelId: 20 }], title: "Second" })!;
    await Promise.all([first.materialized, second.materialized]);
    const drafts = runtime.getVpnDownloadRuntimeSnapshot().drafts;
    await runtime.startVpnDownloadDraft(drafts.find(draft => draft.batchId === first.id)!.id,
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
    await vi.waitFor(() => expect(boundary.complete.has(8)).toBe(true));
    await runtime.startVpnDownloadDraft(drafts.find(draft => draft.batchId === second.id)!.id,
      [{ profileId: "profile-b", startChapterId: 9, endChapterId: 9 }]);
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
      expect(boundary.connect.mock.calls.map(([worker, profile]) => [worker.slot, profile.id])).toEqual([[0, "profile-a"], [0, "profile-b"]]);
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
    await runtime.initializeVpnDownloadRuntime();
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
        [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
      await vi.waitFor(() => expect(boundary.connect).toHaveBeenCalledOnce());
      await runtime.startVpnDownloadDraft(drafts.find(draft => draft.batchId === second.id)!.id,
        [{ profileId: "profile-b", startChapterId: 9, endChapterId: 9 }]);
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
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
    await batch.materialized;
    const create = boundary.createPlan.getMockImplementation()!;
    let release!: () => void;
    const publication = new Promise<void>(resolve => { release = resolve; });
    boundary.createPlan.mockImplementationOnce(async (plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]) => {
      await publication; await create(plan, jobs);
    });
    const starting = runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [
      { profileId: "profile-a", startChapterId: 8, endChapterId: 2 },
      { profileId: "profile-b", startChapterId: 9, endChapterId: 3 },
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
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs: jobs.map(job => ({ ...job, novelId: job.id === 9 || job.id === 3 ? 20 : 10 })), title: "Batch" })!;
    await batch.materialized;
    const drafts = runtime.getVpnDownloadRuntimeSnapshot().drafts;
    await runtime.startVpnDownloadDraft(drafts.find(draft => draft.novelId === 10)!.id,
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 2 }]);
    await runtime.startVpnDownloadDraft(drafts.find(draft => draft.novelId === 20)!.id,
      [{ profileId: "profile-b", startChapterId: 9, endChapterId: 3 }]);
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
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id, [
      { profileId: "profile-a", startChapterId: 8, endChapterId: 2 },
      { profileId: "profile-b", startChapterId: 9, endChapterId: 3 },
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
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges.every(range => range.userPaused)).toBe(true);
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
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
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
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    const create = boundary.createPlan.getMockImplementation()!;
    let publish!: () => void;
    const publication = new Promise<void>(resolve => { publish = resolve; });
    boundary.createPlan.mockImplementationOnce(async (plan: VpnDownloadPlan, jobs: readonly ChapterDownloadJob[]) => {
      await publication; await create(plan, jobs);
    });
    const starting = runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
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
      expect(runtime.getVpnDownloadRuntimeSnapshot().plans[0]!.ranges[0]).toMatchObject({ phase: "paused", userPaused: true });
      expect(boundary.connect).not.toHaveBeenCalled();
      expect(boundary.restoreEffects).toContain("native-restore");
    } finally { publish(); await starting; await finished; cancelInterceptedChapterDownloadBatch(batch.id); await tick(); }
  });

  it("refuses restore without taking barriers when native worker settlement fails and allows explicit resume afterward", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]);
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
      expect(plan.ranges[0]).toMatchObject({ phase: "paused", userPaused: true });
      expect(boundary.connect).toHaveBeenCalledOnce();
      await runtime.resumeVpnDownloadRange(plan.id, plan.ranges[0]!.id);
      await vi.waitFor(() => expect(boundary.connect).toHaveBeenCalledTimes(2));
    } finally { cancelInterceptedChapterDownloadBatch(batch.id); await tick(); }
  });

  it("invalidates a delayed profile lookup so it cannot publish a new worker behind the restore hold", async () => {
    const runtime = await import("./vpn-download-runtime");
    await runtime.initializeVpnDownloadRuntime();
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!;
    await batch.materialized;
    const draft = runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!;
    let profilesReady!: () => void, workersStopped!: () => void;
    const lookup = new Promise<void>(resolve => { profilesReady = resolve; });
    const nativeStop = new Promise<void>(resolve => { workersStopped = resolve; });
    boundary.profiles.mockImplementationOnce(async () => { await lookup; return { limit: 20, profiles, cleanupError: null }; });
    boundary.stop.mockImplementationOnce(async () => { await nativeStop; });
    const assignments = [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }];
    const starting = runtime.startVpnDownloadDraft(draft.id, assignments);
    await vi.waitFor(() => expect(boundary.profiles).toHaveBeenCalledOnce());
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
    const handle = interceptChapterDownloadBatch({ jobs, title: "Batch" })!;
    await expect(handle.materialized).rejects.toThrow(/support/i);
    await expect(handle.promise).rejects.toThrow(/support/i);
    expect(boundary.connect).not.toHaveBeenCalled();
  });

  it("preserves the ordinary batch path when automatic mode is off", async () => {
    useVpnDownloadStore.setState({ mode: "off" });
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    expect(interceptChapterDownloadBatch({ jobs, title: "Batch" })).toBeNull();
    expect(boundary.catalog).not.toHaveBeenCalled();
  });

  it("keeps snapshots stable without changes and releases only the completed worker context", async () => {
    const runtime = await import("./vpn-download-runtime"); await runtime.initializeVpnDownloadRuntime();
    expect(runtime.getVpnDownloadRuntimeSnapshot()).toBe(runtime.getVpnDownloadRuntimeSnapshot());
    const batch = interceptChapterDownloadBatch({ jobs: [jobs[0]!], title: "Batch" })!; await batch.materialized;
    await runtime.startVpnDownloadDraft(runtime.getVpnDownloadRuntimeSnapshot().drafts[0]!.id,
      [{ profileId: "profile-a", startChapterId: 8, endChapterId: 8 }]); await tick();
    const ref = boundary.enqueue.mock.calls[0]![1];
    const contexts = await import("./vpn-worker-context");
    expect(contexts.getVpnDownloadWorkerContext(`vpn:0:${ref.generation}`)).toEqual(ref);
    boundary.complete.get(8)!(); await tick(); await batch.promise;
    expect(contexts.getVpnDownloadWorkerContext(`vpn:0:${ref.generation}`)).toBeUndefined();
    expect(boundary.close).toHaveBeenCalledWith(ref, "source-test");
    expect(boundary.disconnect).toHaveBeenCalledWith(ref);
  });
});
