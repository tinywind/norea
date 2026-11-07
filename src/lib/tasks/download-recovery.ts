import { getDownloadRecoveryPolicy, normalizeDownloadRecoveryPolicy, type DownloadRecoveryAction, type DownloadRecoveryPolicy } from "../../store/download-recovery";
import { isAbortError } from "../abort";
import { ChapterStorageError } from "../chapter-storage-error";
import { errorHttpStatus, isHttpNotFoundError } from "../http/status-error";
import { normalizeSourceAccessRequiredError } from "../plugins/source-access";
import { classifyDownloadFailure, isSourceForbiddenFailure } from "./download-failure";
import type { TaskRunContext } from "./task-types";

export const DOWNLOAD_RECOVERY_STORAGE_KEY = "download-recovery-runtime";
const VERSION = 1;

export interface DownloadRecoveryState {
  key: string;
  sourceId: string;
  title: string;
  origin: string | null;
  status: "waiting" | "resetting" | "retrying" | "switching-profile" | "held";
  action: DownloadRecoveryAction;
  retries: number;
  maxRetries: number;
  nextRetryAt: number | null;
  profileChanges: number;
  maxProfileChanges: number;
  siteResetCount: number;
  error: string;
}

interface RecoveryRegistration {
  sourceId: string;
  title: string;
  policy: DownloadRecoveryPolicy;
}

interface RecoveryEpisode extends DownloadRecoveryState {
  usedProfileIds: string[];
  resetApplied: boolean;
  currentProfileId: string | null;
  currentProfileHash: string | null;
}

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DownloadRecoveryJob {
  id: number;
  pluginId: string;
  title: string;
}

export interface DownloadRecoveryDecision {
  action: DownloadRecoveryAction | "skip";
  reason: "policy" | "budget" | "storage" | "unsupported" | "content";
  delayMs: number;
}

export function downloadRecoveryKey(job: Pick<DownloadRecoveryJob, "id">): string {
  return `chapter:${job.id}`;
}

export function decideDownloadRecovery(
  policy: DownloadRecoveryPolicy,
  error: unknown,
  budget: { retries: number; profileChanges: number; siteResetCount: number },
  context: { vpn: boolean; canResetSite: boolean },
): DownloadRecoveryDecision {
  const failure = classifyDownloadFailure(error);
  const result = (action: DownloadRecoveryDecision["action"], reason: DownloadRecoveryDecision["reason"]): DownloadRecoveryDecision =>
    ({ action, reason, delayMs: Math.max(policy.retryDelaySeconds * 1000, failure.retryAfterMs) });
  if (failure.failureClass === "storage") return result("pause", "storage");
  let action: DownloadRecoveryAction;
  if (isHttpNotFoundError(error)) return result(policy.notFoundAction, "policy");
  const mediaFailures = record(error) && Array.isArray(error.failures) ? error.failures : [];
  if (policy.notFoundAction === "pause" && mediaFailures.some(isHttpNotFoundError)) return result("pause", "policy");
  const pendingMedia = policy.notFoundAction === "skip" ? mediaFailures.filter(item => !isHttpNotFoundError(item)) : mediaFailures;
  const pendingFailure = pendingMedia.length && pendingMedia.length !== mediaFailures.length
    ? classifyDownloadFailure({ code: "chapter-media-incomplete", failures: pendingMedia, retryAfterMs: failure.retryAfterMs, message: failure.summary })
    : failure;
  const mediaStatuses = pendingMedia.map(errorHttpStatus);
  if (isSourceForbiddenFailure(error) || errorHttpStatus(error) === 403 || mediaStatuses.includes(403)) action = policy.forbiddenAction;
  else if (errorHttpStatus(error) === 429 || (mediaStatuses.length > 0 && mediaStatuses.every(status => status === 429))) action = policy.rateLimitAction;
  else if (pendingFailure.failureClass === "transient") action = policy.transientAction;
  else return result("pause", "content");
  if (action === "pause") return result(action, "policy");
  if (budget.retries >= policy.maxRetries) return result("pause", "budget");
  if (action === "nextProfile" && (!context.vpn || budget.profileChanges >= policy.maxProfileChanges)) {
    return result("pause", context.vpn ? "budget" : "unsupported");
  }
  if (action === "resetSite" && (!context.canResetSite || budget.siteResetCount >= 1)) {
    return result("pause", context.canResetSite ? "budget" : "unsupported");
  }
  return result(action, "policy");
}

export class DownloadRecoveryHoldError extends Error {
  readonly code = "download-recovery-held";
  constructor(message: string, readonly originalError?: unknown) {
    super(message, { cause: originalError });
    this.name = "DownloadRecoveryHoldError";
  }
}

export class DownloadRecoveryNextProfileError extends Error {
  readonly code = "download-recovery-next-profile";
  constructor(readonly recoveryKey: string, readonly usedProfileIds: readonly string[]) {
    super("The selected recovery policy requires the next unused VPN profile.");
    this.name = "DownloadRecoveryNextProfileError";
  }
}

export class DownloadRecoveryReconnectError extends Error {
  readonly code = "download-recovery-reconnect";
  constructor() {
    super("Reconnect the current VPN profile after releasing the failed lease.");
    this.name = "DownloadRecoveryReconnectError";
  }
}

export function isDownloadRecoveryReconnect(error: unknown): error is DownloadRecoveryReconnectError {
  return error instanceof DownloadRecoveryReconnectError;
}

export function isDownloadRecoveryHold(error: unknown): error is DownloadRecoveryHoldError {
  return error instanceof DownloadRecoveryHoldError;
}

export function isDownloadRecoveryNextProfile(error: unknown): error is DownloadRecoveryNextProfileError {
  return error instanceof DownloadRecoveryNextProfileError;
}

function originOf(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch { return null; }
}

function defaultStorage(): RecoveryStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function waitUntil(time: number | null, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const delay = (time ?? 0) - Date.now();
  if (delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(delay, 2_147_483_647));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Durable recovery budgets are separate from queue ownership/lease counters. */
export class DownloadRecoveryController {
  private readonly registrations = new Map<string, RecoveryRegistration>();
  private readonly episodes = new Map<string, RecoveryEpisode>();
  private readonly siteResets = new Set<string>();
  private readonly siteLocks = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private loaded = false;
  private snapshot: readonly DownloadRecoveryState[] = [];
  private loadError: unknown;

  constructor(private readonly storage: RecoveryStorage | null = defaultStorage()) {}

  getSnapshot = (): readonly DownloadRecoveryState[] => {
    this.load();
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.storage?.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY);
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (!record(value) || value.version !== VERSION || !Array.isArray(value.policies) ||
          !Array.isArray(value.jobs) || !Array.isArray(value.episodes)) {
        throw new Error("The saved download recovery state is not supported.");
      }
      const policies = value.policies.map(normalizeDownloadRecoveryPolicy);
      for (const row of value.jobs) {
        if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== "string" ||
            typeof row[1] !== "string" || typeof row[2] !== "string" || !policies[row[3]]) {
          throw new Error("The saved download recovery policy is invalid.");
        }
        this.registrations.set(row[0], { sourceId: row[1], title: row[2], policy: policies[row[3]] });
      }
      for (const row of value.episodes) {
        if (!record(row) || typeof row.key !== "string" || !this.registrations.has(row.key) ||
            typeof row.error !== "string" || !["pause", "retry", "resetSite", "nextProfile"].includes(String(row.action)) ||
            !["waiting", "resetting", "retrying", "switching-profile", "held"].includes(String(row.status))) {
          throw new Error("The saved download recovery episode is invalid.");
        }
        if (!["retries", "profileChanges", "siteResetCount"].every(field =>
          typeof row[field] === "number" && Number.isSafeInteger(row[field]) && Number(row[field]) >= 0)) {
          throw new Error("The saved download recovery budget is invalid.");
        }
        const registration = this.registrations.get(row.key)!;
        const interrupted = row.status === "resetting" || row.status === "retrying" || row.status === "switching-profile";
        this.episodes.set(row.key, {
          key: row.key, sourceId: registration.sourceId, title: registration.title,
          origin: originOf(typeof row.origin === "string" ? row.origin : undefined),
          status: interrupted ? "held" : row.status as RecoveryEpisode["status"],
          action: row.action as DownloadRecoveryAction,
          retries: safeCount(row.retries), maxRetries: registration.policy.maxRetries,
          nextRetryAt: typeof row.nextRetryAt === "number" && Number.isSafeInteger(row.nextRetryAt) ? row.nextRetryAt : null,
          profileChanges: safeCount(row.profileChanges), maxProfileChanges: registration.policy.maxProfileChanges,
          siteResetCount: safeCount(row.siteResetCount), resetApplied: row.resetApplied === true,
          currentProfileId: typeof row.currentProfileId === "string" ? row.currentProfileId : null,
          currentProfileHash: typeof row.currentProfileHash === "string" ? row.currentProfileHash : null,
          usedProfileIds: Array.isArray(row.usedProfileIds) ? row.usedProfileIds.filter((id): id is string => typeof id === "string") : [],
          error: interrupted ? "Recovery was interrupted. Resume explicitly to start a new recovery episode." : row.error,
        });
      }
      if (Array.isArray(value.siteResets)) for (const origin of value.siteResets) {
        if (typeof origin === "string" && originOf(origin) === origin) this.siteResets.add(origin);
      }
      this.publish();
    } catch (error) { this.loadError = error; }
  }

  private assertLoaded(): void {
    this.load();
    if (this.loadError) throw new ChapterStorageError("Read download recovery state", this.loadError);
  }

  private persist(): void {
    this.assertLoaded();
    if (!this.storage) {
      if (this.episodes.size) throw new ChapterStorageError("Save download recovery state", new Error("Browser storage is unavailable."));
      return;
    }
    const policies: DownloadRecoveryPolicy[] = [];
    const policyIndexes = new Map<string, number>();
    const jobs = [...this.registrations].map(([key, registration]) => {
      const serialized = JSON.stringify(registration.policy);
      let index = policyIndexes.get(serialized);
      if (index === undefined) { index = policies.length; policyIndexes.set(serialized, index); policies.push(registration.policy); }
      return [key, registration.sourceId, registration.title, index];
    });
    try {
      this.storage.setItem(DOWNLOAD_RECOVERY_STORAGE_KEY, JSON.stringify({
        version: VERSION, policies, jobs, episodes: [...this.episodes.values()], siteResets: [...this.siteResets],
      }));
    } catch (error) { throw new ChapterStorageError("Save download recovery state", error); }
    this.publish();
  }

  private publish(): void {
    this.snapshot = [...this.episodes.values()].map(({ usedProfileIds: _profiles, resetApplied: _reset, currentProfileId: _profile, currentProfileHash: _hash, ...state }) => ({ ...state }));
    for (const listener of this.listeners) listener();
  }

  register(jobs: readonly DownloadRecoveryJob[], policy = getDownloadRecoveryPolicy()): void {
    this.assertLoaded();
    let changed = false;
    for (const job of jobs) {
      const key = downloadRecoveryKey(job);
      if (this.registrations.has(key)) continue;
      this.registrations.set(key, { sourceId: job.pluginId, title: job.title, policy: normalizeDownloadRecoveryPolicy(policy) });
      changed = true;
    }
    if (changed) this.persist();
  }

  /** Only an explicit resume adopts changed settings and starts another episode. */
  resume(sourceId?: string, keys?: ReadonlySet<string>): void {
    this.assertLoaded();
    const policy = getDownloadRecoveryPolicy();
    for (const [key, registration] of this.registrations) {
      if ((sourceId && registration.sourceId !== sourceId) || (keys && !keys.has(key))) continue;
      this.registrations.set(key, { ...registration, policy });
      const episode = this.episodes.get(key);
      if (episode?.origin) this.siteResets.delete(episode.origin);
      this.episodes.delete(key);
    }
    this.persist();
  }

  forget(keys: Iterable<string>, recovered = false): void {
    this.assertLoaded();
    let changed = false;
    for (const key of keys) {
      const episode = this.episodes.get(key);
      if (recovered && episode?.origin && episode.siteResetCount) this.siteResets.delete(episode.origin);
      changed = this.episodes.delete(key) || changed;
      changed = this.registrations.delete(key) || changed;
    }
    if (changed) this.persist();
  }

  usedProfiles(key: string): readonly string[] {
    this.assertLoaded();
    return [...(this.episodes.get(key)?.usedProfileIds ?? [])];
  }

  /** A connectivity event is one interrupted attempt, never permission to reconnect without a budget. */
  networkLost(key: string, error: unknown, options: { url?: string; profile?: { id: string; hash: string } } = {}): DownloadRecoveryAction | null {
    this.assertLoaded();
    const registration = this.registrations.get(key);
    if (!registration) return null;
    const previous = this.episodes.get(key);
    if (previous?.status === "held") return "pause";
    if (previous?.status === "waiting") return previous.action;
    const decision = decideDownloadRecovery(registration.policy, error, {
      retries: previous?.retries ?? 0, profileChanges: previous?.profileChanges ?? 0,
      siteResetCount: previous?.siteResetCount ?? 0,
    }, { vpn: Boolean(options.profile), canResetSite: false });
    const action = decision.action === "skip" ? "pause" : decision.action;
    const profileId = options.profile?.id ?? previous?.currentProfileId ?? null;
    const used = [...(previous?.usedProfileIds ?? [])];
    if (action === "nextProfile" && profileId && !used.includes(profileId)) used.push(profileId);
    this.episodes.set(key, {
      key, sourceId: registration.sourceId, title: registration.title,
      origin: originOf(options.url) ?? previous?.origin ?? null,
      status: action === "pause" ? "held" : "waiting", action,
      retries: (previous?.retries ?? 0) + (action === "pause" ? 0 : 1),
      maxRetries: registration.policy.maxRetries,
      nextRetryAt: action === "pause" ? null : Date.now() + decision.delayMs,
      profileChanges: (previous?.profileChanges ?? 0) + (action === "nextProfile" ? 1 : 0),
      maxProfileChanges: registration.policy.maxProfileChanges,
      siteResetCount: previous?.siteResetCount ?? 0, resetApplied: previous?.resetApplied ?? false,
      usedProfileIds: used, currentProfileId: profileId,
      currentProfileHash: options.profile?.hash ?? previous?.currentProfileHash ?? null,
      error: classifyDownloadFailure(error).summary,
    });
    this.persist();
    return action;
  }

  retryProfile(key: string): { id: string; hash: string | null } | null {
    this.assertLoaded();
    const episode = this.episodes.get(key);
    return episode && episode.action !== "nextProfile" && episode.currentProfileId
      ? { id: episode.currentProfileId, hash: episode.currentProfileHash } : null;
  }

  async connect<T>(job: DownloadRecoveryJob, profile: { id: string; hash: string }, signal: AbortSignal, connect: () => Promise<T>): Promise<T> {
    let attempted = false;
    return this.run({
      job, vpn: true, profileId: () => profile.id, profileHash: () => profile.hash, retainOnSuccess: true,
    }, { signal, taskId: downloadRecoveryKey(job), setDetail: () => undefined, setProgress: () => undefined }, async () => {
      if (attempted) throw new DownloadRecoveryReconnectError();
      attempted = true;
      return connect();
    });
  }

  private async lock<T>(site: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.siteLocks.get(site) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => turn);
    this.siteLocks.set(site, tail);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        void previous.then(() => { signal.removeEventListener("abort", abort); resolve(); });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      return await operation();
    } finally {
      release();
      void tail.then(() => { if (this.siteLocks.get(site) === tail) this.siteLocks.delete(site); });
    }
  }

  async run<T>(options: {
    job: DownloadRecoveryJob;
    url?: string;
    vpn?: boolean;
    profileId?: () => string | null | Promise<string | null>;
    profileHash?: () => string | null;
    retainOnSuccess?: boolean;
    policy?: DownloadRecoveryPolicy;
    resetSite?: (sourceId: string, url: string) => Promise<void>;
  }, context: TaskRunContext, operation: (context: TaskRunContext) => Promise<T>): Promise<T> {
    const key = downloadRecoveryKey(options.job);
    this.register([options.job], options.policy);
    const registration = this.registrations.get(key)!;
    let currentUrl = options.url;
    const originalSetUrl = context.setSourceAccessUrl;
    let deferred = false;
    const attemptContext: TaskRunContext = { ...context, setSourceAccessUrl: url => {
      currentUrl = url;
      return originalSetUrl?.(url) ?? true;
    }, ...(context.tryStartSourceAccess ? { tryStartSourceAccess: () => {
      const started = context.tryStartSourceAccess!();
      deferred ||= !started;
      return started;
    } } : {}) };
    let recovering = false;
    const execute = async (): Promise<T> => {
      for (;;) {
        context.signal.throwIfAborted();
        let episode = this.episodes.get(key);
        if (episode?.status === "held") throw new DownloadRecoveryHoldError(episode.error);
        if (episode && !recovering) {
          return this.lock(episode.origin ?? originOf(options.url) ?? options.job.pluginId, context.signal, async () => {
            recovering = true;
            return execute();
          });
        }
        if (episode) {
          context.setDetail(episode.action === "nextProfile" ? "Waiting for the next VPN profile." : "Waiting for download recovery.");
          await waitUntil(episode.nextRetryAt, context.signal);
          context.signal.throwIfAborted();
          if (episode.action !== "nextProfile" && options.vpn && episode.currentProfileId) {
            const profile = await options.profileId?.();
            const hash = options.profileHash?.();
            if (profile !== episode.currentProfileId || (hash && episode.currentProfileHash && hash !== episode.currentProfileHash)) {
              episode.status = "held";
              episode.error = "The original VPN profile changed. Resume explicitly before retrying.";
              this.persist();
              throw new DownloadRecoveryHoldError(episode.error);
            }
          }
          if (episode.action === "nextProfile") {
            const profile = await options.profileId?.();
            if (!profile || episode.usedProfileIds.includes(profile)) {
              episode.status = "switching-profile";
              episode.nextRetryAt = null;
              this.persist();
              throw new DownloadRecoveryNextProfileError(key, episode.usedProfileIds);
            }
            episode.usedProfileIds.push(profile);
            episode.currentProfileId = profile;
            episode.currentProfileHash = options.profileHash?.() ?? null;
            episode.action = "retry";
          }
          if (episode.action === "resetSite" && !episode.resetApplied) {
            episode.status = "resetting";
            this.persist();
            try {
              context.signal.throwIfAborted();
              const reset = options.resetSite ?? (await import("../site-browser/session")).resetSourceSiteData;
              await reset(registration.sourceId, episode.origin!);
              episode.resetApplied = true;
              this.persist();
              context.signal.throwIfAborted();
            } catch (error) {
              episode.status = "held";
              episode.error = isAbortError(error) || context.signal.aborted
                ? "Site reset was interrupted. Resume explicitly before retrying."
                : `Site reset failed: ${classifyDownloadFailure(error).summary}`;
              this.persist();
              throw isAbortError(error) || context.signal.aborted ? error : new DownloadRecoveryHoldError(episode.error, error);
            }
          }
          episode.status = "retrying";
          episode.nextRetryAt = null;
          this.persist();
          context.setDetail("Retrying download with the selected recovery policy.");
        }
        try {
          deferred = false;
          const value = await operation(attemptContext);
          context.signal.throwIfAborted();
          if (!deferred && !options.retainOnSuccess) this.forget([key], true);
          else if (deferred && episode) { episode.status = "waiting"; this.persist(); }
          return value;
        } catch (error) {
          if (context.signal.aborted || isAbortError(error) || isDownloadRecoveryReconnect(error) || isDownloadRecoveryNextProfile(error)) throw error;
          const failure = classifyDownloadFailure(error);
          if (failure.failureClass === "storage") throw error;
          const challenge = normalizeSourceAccessRequiredError(error);
          const origin = originOf(challenge?.challenge.url ?? currentUrl);
          episode = this.episodes.get(key);
          const budget = {
            retries: episode?.retries ?? 0,
            profileChanges: episode?.profileChanges ?? 0,
            siteResetCount: Math.max(episode?.siteResetCount ?? 0, origin && this.siteResets.has(origin) ? 1 : 0),
          };
          const decision = decideDownloadRecovery(registration.policy, error, budget, {
            vpn: options.vpn === true, canResetSite: origin !== null,
          });
          if (decision.action === "skip") { this.forget([key]); throw error; }
          const next: RecoveryEpisode = {
            key, sourceId: registration.sourceId, title: registration.title, origin,
            status: decision.action === "pause" ? "held" : "waiting", action: decision.action,
            retries: budget.retries + (decision.action === "pause" ? 0 : 1),
            maxRetries: registration.policy.maxRetries,
            nextRetryAt: decision.action === "pause" ? null : Date.now() + decision.delayMs,
            profileChanges: budget.profileChanges + (decision.action === "nextProfile" ? 1 : 0),
            maxProfileChanges: registration.policy.maxProfileChanges,
            siteResetCount: (episode?.siteResetCount ?? 0) + (decision.action === "resetSite" ? 1 : 0),
            usedProfileIds: [...(episode?.usedProfileIds ?? [])],
            resetApplied: decision.action === "resetSite" ? false : episode?.resetApplied ?? false,
            currentProfileId: episode?.currentProfileId ?? null,
            currentProfileHash: episode?.currentProfileHash ?? null,
            error: failure.summary,
          };
          const profile = decision.action !== "pause" && options.vpn ? await options.profileId?.() : null;
          if (profile) next.currentProfileId = profile;
          next.currentProfileHash = options.profileHash?.() ?? next.currentProfileHash;
          if (decision.action === "nextProfile" && profile && !next.usedProfileIds.includes(profile)) next.usedProfileIds.push(profile);
          if (decision.action === "resetSite" && origin) this.siteResets.add(origin);
          this.episodes.set(key, next);
          // Persist the reservation before waiting, resetting site data, or selecting another VPN.
          this.persist();
          if (decision.action === "pause") {
            if (isHttpNotFoundError(error)) throw new DownloadRecoveryHoldError(failure.summary, error);
            throw error;
          }
        }
      }
    };
    return execute();
  }
}

export const downloadRecovery = new DownloadRecoveryController();
export const getDownloadRecoverySnapshot = downloadRecovery.getSnapshot;
export const subscribeDownloadRecovery = downloadRecovery.subscribe;
