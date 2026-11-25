import { getDownloadRecoveryPolicy, normalizeDownloadRecoveryPolicy, type DownloadRecoveryAction, type DownloadRecoveryPolicy } from "../../store/download-recovery";
import { isAbortError } from "../abort";
import { isChapterMediaIncompleteError } from "../chapter-media/errors";
import { ChapterStorageError } from "../chapter-storage-error";
import { errorHttpStatus, isHttpNotFoundError } from "../http/status-error";
import { normalizeSourceAccessRequiredError } from "../plugins/source-access";
import {
  classifyDownloadFailure,
  isChapterMediaVerificationFailure,
  isSkippableIncompleteMediaFailure,
  isSourceForbiddenFailure,
} from "./download-failure";
import type { TaskRunContext } from "./task-types";

export const DOWNLOAD_RECOVERY_STORAGE_KEY = "download-recovery-runtime";
const LEGACY_VERSION = 1;
const VERSION = 2;
const CHAPTER_KEY_PREFIX = "chapter:";
/** Hard bounds on persisted non-episode policy overrides so localStorage stays well below quota. */
const MAX_PERSISTED_OVERRIDE_RANGES = 1_000;
const MAX_PERSISTED_OVERRIDE_KEYS = 256;

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
  policy: DownloadRecoveryPolicy;
  usedProfileIds: string[];
  resetApplied: boolean;
  currentProfileId: string | null;
  currentProfileHash: string | null;
}

interface PolicyOverrideEntry {
  sourceId: string;
  policy: DownloadRecoveryPolicy;
}

interface PolicyOverrideRange extends PolicyOverrideEntry {
  start: number;
  end: number;
}

interface PolicyOverrideState {
  ranges: PolicyOverrideRange[];
  keys: Map<string, PolicyOverrideEntry>;
}

interface PersistedPolicyOverrideGroup {
  sourceId: string;
  policyIndex: number;
  ranges?: [number, number][];
  keys?: string[];
}

interface PersistedRecoveryEpisode extends Omit<RecoveryEpisode, "policy"> {
  policyIndex: number;
}

interface PersistedState {
  sourcePolicies: Map<string, DownloadRecoveryPolicy>;
  overrides: PolicyOverrideState;
  episodes: Map<string, RecoveryEpisode>;
  siteResets: Set<string>;
}

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
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
  return `${CHAPTER_KEY_PREFIX}${job.id}`;
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
  else if (errorHttpStatus(error) === 429 || mediaStatuses.includes(429)) action = policy.rateLimitAction;
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

function policiesEqual(left: DownloadRecoveryPolicy, right: DownloadRecoveryPolicy): boolean {
  return left === right || (
    left.forbiddenAction === right.forbiddenAction &&
    left.transientAction === right.transientAction &&
    left.rateLimitAction === right.rateLimitAction &&
    left.notFoundAction === right.notFoundAction &&
    left.maxRetries === right.maxRetries &&
    left.retryDelaySeconds === right.retryDelaySeconds &&
    left.maxProfileChanges === right.maxProfileChanges &&
    left.rotateFingerprintOnVpnChange === right.rotateFingerprintOnVpnChange
  );
}

function policySignature(policy: DownloadRecoveryPolicy): string {
  return JSON.stringify([
    policy.forbiddenAction,
    policy.transientAction,
    policy.rateLimitAction,
    policy.notFoundAction,
    policy.maxRetries,
    policy.retryDelaySeconds,
    policy.maxProfileChanges,
    policy.rotateFingerprintOnVpnChange,
  ]);
}

function parseChapterKeyId(key: string): number | null {
  if (!key.startsWith(CHAPTER_KEY_PREFIX)) return null;
  const raw = key.slice(CHAPTER_KEY_PREFIX.length);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function emptyOverrides(): PolicyOverrideState {
  return { ranges: [], keys: new Map() };
}

function cloneOverrides(overrides: PolicyOverrideState): PolicyOverrideState {
  return {
    ranges: overrides.ranges.map(range => ({ ...range })),
    keys: new Map(overrides.keys),
  };
}

function compressNumericIds(ids: readonly number[]): [number, number][] {
  if (ids.length === 0) return [];
  const sorted = ids.slice().sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  let start = sorted[0]!;
  let end = start;
  for (let i = 1; i < sorted.length; i++) {
    const id = sorted[i]!;
    if (id === end) continue;
    if (id === end + 1) {
      end = id;
    } else {
      ranges.push([start, end]);
      start = id;
      end = id;
    }
  }
  ranges.push([start, end]);
  return ranges;
}

function subtractRanges(
  existing: readonly PolicyOverrideRange[],
  removeRanges: readonly [number, number][],
): PolicyOverrideRange[] {
  if (existing.length === 0 || removeRanges.length === 0) return existing.map(range => ({ ...range }));
  const result: PolicyOverrideRange[] = [];
  let removeIndex = 0;
  for (const range of existing) {
    let curStart = range.start;
    const curEnd = range.end;
    while (removeIndex < removeRanges.length && removeRanges[removeIndex]![1] < curStart) {
      removeIndex++;
    }
    let scan = removeIndex;
    while (scan < removeRanges.length && removeRanges[scan]![0] <= curEnd) {
      const [remStart, remEnd] = removeRanges[scan]!;
      if (remStart > curStart) {
        result.push({ start: curStart, end: remStart - 1, sourceId: range.sourceId, policy: range.policy });
      }
      if (remEnd >= curEnd) {
        curStart = curEnd + 1;
        break;
      }
      curStart = remEnd + 1;
      scan++;
    }
    if (curStart <= curEnd) {
      result.push({ start: curStart, end: curEnd, sourceId: range.sourceId, policy: range.policy });
    }
  }
  return result;
}

function upsertOverrideRanges(
  existing: readonly PolicyOverrideRange[],
  additions: readonly PolicyOverrideRange[],
): PolicyOverrideRange[] {
  if (additions.length === 0) return existing.map(range => ({ ...range }));
  const sortedAdd = additions.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const addIntervals: [number, number][] = [];
  for (const item of sortedAdd) {
    const last = addIntervals[addIntervals.length - 1];
    if (last && item.start <= last[1] + 1) {
      if (item.end > last[1]) last[1] = item.end;
    } else {
      addIntervals.push([item.start, item.end]);
    }
  }
  const stripped = subtractRanges(existing, addIntervals);
  const combined = stripped.concat(sortedAdd).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: PolicyOverrideRange[] = [];
  for (const range of combined) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1 && last.sourceId === range.sourceId && policiesEqual(last.policy, range.policy)) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function lookupOverride(overrides: PolicyOverrideState, key: string): PolicyOverrideEntry | undefined {
  const id = parseChapterKeyId(key);
  if (id === null) return overrides.keys.get(key);
  let lo = 0;
  let hi = overrides.ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = overrides.ranges[mid]!;
    if (id < range.start) hi = mid - 1;
    else if (id > range.end) lo = mid + 1;
    else return { sourceId: range.sourceId, policy: range.policy };
  }
  return undefined;
}

function upsertOverrideEntries(
  overrides: PolicyOverrideState,
  entries: readonly { key: string; sourceId: string; policy: DownloadRecoveryPolicy }[],
): PolicyOverrideState {
  if (entries.length === 0) return cloneOverrides(overrides);
  const buckets = new Map<string, { sourceId: string; policy: DownloadRecoveryPolicy; ids: number[] }>();
  const nextKeys = new Map(overrides.keys);
  for (const entry of entries) {
    const id = parseChapterKeyId(entry.key);
    if (id === null) {
      nextKeys.set(entry.key, { sourceId: entry.sourceId, policy: entry.policy });
      continue;
    }
    const bucketKey = `${entry.sourceId}\u0000${policySignature(entry.policy)}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { sourceId: entry.sourceId, policy: entry.policy, ids: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.ids.push(id);
  }
  const additions: PolicyOverrideRange[] = [];
  for (const bucket of buckets.values()) {
    for (const [start, end] of compressNumericIds(bucket.ids)) {
      additions.push({ start, end, sourceId: bucket.sourceId, policy: bucket.policy });
    }
  }
  return {
    ranges: upsertOverrideRanges(overrides.ranges, additions),
    keys: nextKeys,
  };
}

function deleteOverridesByKeys(overrides: PolicyOverrideState, keys: Iterable<string>): PolicyOverrideState {
  const ids: number[] = [];
  const nextKeys = new Map(overrides.keys);
  for (const key of keys) {
    const id = parseChapterKeyId(key);
    if (id === null) nextKeys.delete(key);
    else ids.push(id);
  }
  return {
    ranges: ids.length ? subtractRanges(overrides.ranges, compressNumericIds(ids)) : overrides.ranges.map(range => ({ ...range })),
    keys: nextKeys,
  };
}

function deleteOverridesBySource(overrides: PolicyOverrideState, sourceId: string): PolicyOverrideState {
  const nextKeys = new Map<string, PolicyOverrideEntry>();
  for (const [key, entry] of overrides.keys) {
    if (entry.sourceId !== sourceId) nextKeys.set(key, entry);
  }
  return {
    ranges: overrides.ranges.filter(range => range.sourceId !== sourceId).map(range => ({ ...range })),
    keys: nextKeys,
  };
}

function pruneOverrides(
  overrides: PolicyOverrideState,
  activeKeys: ReadonlySet<string>,
  episodes: ReadonlyMap<string, RecoveryEpisode>,
): PolicyOverrideState {
  if (overrides.ranges.length === 0 && overrides.keys.size === 0) return emptyOverrides();
  const kept: { key: string; sourceId: string; policy: DownloadRecoveryPolicy }[] = [];
  for (const key of activeKeys) {
    if (episodes.has(key)) continue;
    const entry = lookupOverride(overrides, key);
    if (entry) kept.push({ key, sourceId: entry.sourceId, policy: entry.policy });
  }
  return upsertOverrideEntries(emptyOverrides(), kept);
}

function sourceHasOverrides(overrides: PolicyOverrideState, sourceId: string): boolean {
  if (overrides.ranges.some(range => range.sourceId === sourceId)) return true;
  for (const entry of overrides.keys.values()) {
    if (entry.sourceId === sourceId) return true;
  }
  return false;
}

function sourceHasEpisode(episodes: ReadonlyMap<string, RecoveryEpisode>, sourceId: string): boolean {
  for (const episode of episodes.values()) {
    if (episode.sourceId === sourceId) return true;
  }
  return false;
}

function serializePersistedState(state: PersistedState): string {
  const policies: DownloadRecoveryPolicy[] = [];
  const policyIndexes = new Map<string, number>();
  const internPolicy = (policy: DownloadRecoveryPolicy): number => {
    const sig = policySignature(policy);
    let index = policyIndexes.get(sig);
    if (index === undefined) {
      index = policies.length;
      policyIndexes.set(sig, index);
      policies.push(policy);
    }
    return index;
  };

  const sourcePolicies: Record<string, number> = {};
  for (const sourceId of [...state.sourcePolicies.keys()].sort()) {
    sourcePolicies[sourceId] = internPolicy(state.sourcePolicies.get(sourceId)!);
  }

  const episodes: PersistedRecoveryEpisode[] = [...state.episodes.values()].map(({ policy, ...rest }) => ({
    ...rest,
    policyIndex: internPolicy(policy),
  }));

  const overrideGroups = new Map<string, {
    sourceId: string;
    policy: DownloadRecoveryPolicy;
    ranges: [number, number][];
    keys: string[];
  }>();
  const groupFor = (sourceId: string, policy: DownloadRecoveryPolicy) => {
    const key = `${sourceId}\u0000${policySignature(policy)}`;
    let group = overrideGroups.get(key);
    if (!group) {
      group = { sourceId, policy, ranges: [], keys: [] };
      overrideGroups.set(key, group);
    }
    return group;
  };

  let remainingRanges = MAX_PERSISTED_OVERRIDE_RANGES;
  for (const range of state.overrides.ranges) {
    if (remainingRanges <= 0) break;
    const baseline = state.sourcePolicies.get(range.sourceId);
    if (baseline && policiesEqual(baseline, range.policy)) continue;
    groupFor(range.sourceId, range.policy).ranges.push([range.start, range.end]);
    remainingRanges--;
  }

  let remainingKeys = MAX_PERSISTED_OVERRIDE_KEYS;
  for (const key of [...state.overrides.keys.keys()].sort()) {
    if (remainingKeys <= 0) break;
    if (state.episodes.has(key)) continue;
    const entry = state.overrides.keys.get(key)!;
    const baseline = state.sourcePolicies.get(entry.sourceId);
    if (baseline && policiesEqual(baseline, entry.policy)) continue;
    groupFor(entry.sourceId, entry.policy).keys.push(key);
    remainingKeys--;
  }

  const policyOverrides: PersistedPolicyOverrideGroup[] = [...overrideGroups.values()]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || policySignature(a.policy).localeCompare(policySignature(b.policy)))
    .map(group => ({
      sourceId: group.sourceId,
      policyIndex: internPolicy(group.policy),
      ...(group.ranges.length ? { ranges: group.ranges } : {}),
      ...(group.keys.length ? { keys: group.keys } : {}),
    }));

  return JSON.stringify({
    version: VERSION,
    policies,
    sourcePolicies,
    policyOverrides,
    episodes,
    siteResets: [...state.siteResets].sort(),
  });
}

function parseEpisodeRow(
  row: Record<string, unknown>,
  meta: { sourceId: string; title: string; policy: DownloadRecoveryPolicy },
): RecoveryEpisode {
  if (
    typeof row.key !== "string" ||
    typeof row.error !== "string" ||
    !["pause", "retry", "resetSite", "nextProfile"].includes(String(row.action)) ||
    !["waiting", "resetting", "retrying", "switching-profile", "held"].includes(String(row.status))
  ) {
    throw new Error("The saved download recovery episode is invalid.");
  }
  if (!["retries", "profileChanges", "siteResetCount"].every(field =>
    typeof row[field] === "number" && Number.isSafeInteger(row[field]) && Number(row[field]) >= 0)) {
    throw new Error("The saved download recovery budget is invalid.");
  }
  const interrupted = row.status === "resetting" || row.status === "retrying" || row.status === "switching-profile";
  return {
    key: row.key,
    sourceId: meta.sourceId,
    title: meta.title,
    policy: meta.policy,
    origin: originOf(typeof row.origin === "string" ? row.origin : undefined),
    status: interrupted ? "held" : row.status as RecoveryEpisode["status"],
    action: row.action as DownloadRecoveryAction,
    retries: safeCount(row.retries),
    maxRetries: meta.policy.maxRetries,
    nextRetryAt: typeof row.nextRetryAt === "number" && Number.isSafeInteger(row.nextRetryAt) ? row.nextRetryAt : null,
    profileChanges: safeCount(row.profileChanges),
    maxProfileChanges: meta.policy.maxProfileChanges,
    siteResetCount: safeCount(row.siteResetCount),
    resetApplied: row.resetApplied === true,
    currentProfileId: typeof row.currentProfileId === "string" ? row.currentProfileId : null,
    currentProfileHash: typeof row.currentProfileHash === "string" ? row.currentProfileHash : null,
    usedProfileIds: Array.isArray(row.usedProfileIds) ? row.usedProfileIds.filter((id): id is string => typeof id === "string") : [],
    error: interrupted ? "Recovery was interrupted. Resume explicitly to start a new recovery episode." : row.error,
  };
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
  private readonly sourceRegistrationCounts = new Map<string, number>();
  private readonly restoredSourcePolicies = new Set<string>();
  private sourcePolicies = new Map<string, DownloadRecoveryPolicy>();
  private overrides: PolicyOverrideState = emptyOverrides();
  private episodes = new Map<string, RecoveryEpisode>();
  private siteResets = new Set<string>();
  private readonly siteLocks = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private loaded = false;
  private lastPersistedJson: string | null = null;
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

  private setRegistration(key: string, registration: RecoveryRegistration): void {
    const previous = this.registrations.get(key);
    if (previous) {
      if (previous.sourceId !== registration.sourceId) {
        this.adjustSourceCount(previous.sourceId, -1);
        this.adjustSourceCount(registration.sourceId, 1);
      }
    } else {
      this.adjustSourceCount(registration.sourceId, 1);
    }
    this.registrations.set(key, registration);
  }

  private deleteRegistration(key: string): RecoveryRegistration | undefined {
    const previous = this.registrations.get(key);
    if (!previous) return undefined;
    this.registrations.delete(key);
    this.adjustSourceCount(previous.sourceId, -1);
    return previous;
  }

  private adjustSourceCount(sourceId: string, delta: number): void {
    const next = (this.sourceRegistrationCounts.get(sourceId) ?? 0) + delta;
    if (next > 0) this.sourceRegistrationCounts.set(sourceId, next);
    else this.sourceRegistrationCounts.delete(sourceId);
  }

  private policyFor(job: Pick<DownloadRecoveryJob, "id" | "pluginId">): DownloadRecoveryPolicy {
    const key = downloadRecoveryKey(job);
    const existing = this.registrations.get(key);
    if (existing) return existing.policy;
    const episode = this.episodes.get(key);
    if (episode) return episode.policy;
    const override = lookupOverride(this.overrides, key);
    if (override) return override.policy;
    const sourcePolicy = this.sourcePolicies.get(job.pluginId);
    if (sourcePolicy) return sourcePolicy;
    return getDownloadRecoveryPolicy();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.storage?.getItem(DOWNLOAD_RECOVERY_STORAGE_KEY);
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (!record(value)) {
        throw new Error("The saved download recovery state is not supported.");
      }
      if (value.version === LEGACY_VERSION) {
        this.loadLegacyV1(value, raw.length);
        return;
      }
      if (value.version === VERSION) {
        this.loadV2(value, raw);
        return;
      }
      throw new Error("The saved download recovery state is not supported.");
    } catch (error) {
      this.loadError = error;
    }
  }

  private loadLegacyV1(value: Record<string, unknown>, rawLength: number): void {
    if (!Array.isArray(value.policies) || !Array.isArray(value.jobs) || !Array.isArray(value.episodes)) {
      throw new Error("The saved download recovery state is not supported.");
    }
    const policies = value.policies.map(normalizeDownloadRecoveryPolicy);
    const episodeKeys = new Set<string>();
    for (const row of value.episodes) {
      if (!record(row) || typeof row.key !== "string") {
        throw new Error("The saved download recovery episode is invalid.");
      }
      episodeKeys.add(row.key);
    }

    const sourcePolicyCounts = new Map<string, Map<number, number>>();
    const episodeMeta = new Map<string, RecoveryRegistration>();

    for (const row of value.jobs) {
      if (
        !Array.isArray(row) || row.length !== 4 ||
        typeof row[0] !== "string" || typeof row[1] !== "string" || typeof row[2] !== "string" ||
        typeof row[3] !== "number" || !Number.isSafeInteger(row[3]) || !policies[row[3]]
      ) {
        throw new Error("The saved download recovery policy is invalid.");
      }
      const [key, sourceId, title, policyIndex] = row as [string, string, string, number];
      let counts = sourcePolicyCounts.get(sourceId);
      if (!counts) {
        counts = new Map();
        sourcePolicyCounts.set(sourceId, counts);
      }
      counts.set(policyIndex, (counts.get(policyIndex) ?? 0) + 1);
      if (episodeKeys.has(key)) {
        episodeMeta.set(key, { sourceId, title, policy: policies[policyIndex]! });
      }
    }

    const nextSourcePolicies = new Map<string, DownloadRecoveryPolicy>();
    const sourceMajorityIndex = new Map<string, number>();
    let hasMixedSourcePolicy = false;
    for (const [sourceId, counts] of sourcePolicyCounts) {
      if (counts.size > 1) hasMixedSourcePolicy = true;
      let bestIndex = 0;
      let bestCount = -1;
      for (const [policyIndex, count] of counts) {
        if (count > bestCount) {
          bestIndex = policyIndex;
          bestCount = count;
        }
      }
      sourceMajorityIndex.set(sourceId, bestIndex);
      nextSourcePolicies.set(sourceId, policies[bestIndex]!);
    }

    const overrideEntries: { key: string; sourceId: string; policy: DownloadRecoveryPolicy }[] = [];
    if (hasMixedSourcePolicy) {
      for (const row of value.jobs) {
        const [key, sourceId, , policyIndex] = row as [string, string, string, number];
        if (episodeKeys.has(key)) continue;
        if (policyIndex === sourceMajorityIndex.get(sourceId)) continue;
        const baselinePolicy = nextSourcePolicies.get(sourceId);
        const jobPolicy = policies[policyIndex]!;
        if (!baselinePolicy || !policiesEqual(baselinePolicy, jobPolicy)) {
          overrideEntries.push({ key, sourceId, policy: jobPolicy });
        }
      }
    }
    const nextOverrides = upsertOverrideEntries(emptyOverrides(), overrideEntries);

    const nextEpisodes = new Map<string, RecoveryEpisode>();
    for (const row of value.episodes) {
      if (!record(row) || typeof row.key !== "string" || !episodeMeta.has(row.key)) {
        throw new Error("The saved download recovery episode is invalid.");
      }
      const meta = episodeMeta.get(row.key)!;
      nextEpisodes.set(row.key, parseEpisodeRow(row, meta));
    }

    const nextSiteResets = new Set<string>();
    if (Array.isArray(value.siteResets)) {
      for (const origin of value.siteResets) {
        if (typeof origin === "string" && originOf(origin) === origin) nextSiteResets.add(origin);
      }
    }

    this.sourcePolicies = nextSourcePolicies;
    this.overrides = nextOverrides;
    this.episodes = nextEpisodes;
    this.siteResets = nextSiteResets;
    for (const sourceId of nextSourcePolicies.keys()) this.restoredSourcePolicies.add(sourceId);
    for (const [key, episode] of nextEpisodes) {
      this.setRegistration(key, { sourceId: episode.sourceId, title: episode.title, policy: episode.policy });
    }

    const compacted = serializePersistedState({
      sourcePolicies: this.sourcePolicies,
      overrides: this.overrides,
      episodes: this.episodes,
      siteResets: this.siteResets,
    });
    if (this.storage) {
      try {
        this.storage.setItem(DOWNLOAD_RECOVERY_STORAGE_KEY, compacted);
        this.lastPersistedJson = compacted;
      } catch {
        // Some storage backends check quota before subtracting the replaced entry's size.
        if (this.storage.removeItem && compacted.length < rawLength) {
          try {
            this.storage.removeItem(DOWNLOAD_RECOVERY_STORAGE_KEY);
            this.storage.setItem(DOWNLOAD_RECOVERY_STORAGE_KEY, compacted);
            this.lastPersistedJson = compacted;
          } catch {
            // Keep the migrated state in memory; the next explicit persist() will retry.
          }
        }
      }
    }
    this.publish();
  }

  private loadV2(value: Record<string, unknown>, raw: string): void {
    if (!Array.isArray(value.policies) || !Array.isArray(value.episodes)) {
      throw new Error("The saved download recovery state is not supported.");
    }
    const policies = value.policies.map(normalizeDownloadRecoveryPolicy);

    const nextSourcePolicies = new Map<string, DownloadRecoveryPolicy>();
    if (value.sourcePolicies !== undefined) {
      if (!record(value.sourcePolicies)) {
        throw new Error("The saved download recovery policy is invalid.");
      }
      for (const [sourceId, policyIndex] of Object.entries(value.sourcePolicies)) {
        if (typeof policyIndex !== "number" || !Number.isSafeInteger(policyIndex) || !policies[policyIndex]) {
          throw new Error("The saved download recovery policy is invalid.");
        }
        nextSourcePolicies.set(sourceId, policies[policyIndex]!);
      }
    }

    let nextOverrides = emptyOverrides();
    if (value.policyOverrides !== undefined) {
      if (!Array.isArray(value.policyOverrides)) {
        throw new Error("The saved download recovery policy is invalid.");
      }
      for (const group of value.policyOverrides) {
        if (
          !record(group) || typeof group.sourceId !== "string" ||
          typeof group.policyIndex !== "number" || !Number.isSafeInteger(group.policyIndex) || !policies[group.policyIndex]
        ) {
          throw new Error("The saved download recovery policy is invalid.");
        }
        const groupSourceId = group.sourceId;
        const groupPolicy = policies[group.policyIndex]!;
        if (group.ranges !== undefined) {
          if (!Array.isArray(group.ranges)) {
            throw new Error("The saved download recovery policy is invalid.");
          }
          const parsedRanges: PolicyOverrideRange[] = [];
          for (const item of group.ranges) {
            if (
              !Array.isArray(item) || item.length !== 2 ||
              typeof item[0] !== "number" || typeof item[1] !== "number" ||
              !Number.isSafeInteger(item[0]) || !Number.isSafeInteger(item[1]) ||
              item[0] <= 0 || item[1] < item[0]
            ) {
              throw new Error("The saved download recovery policy is invalid.");
            }
            parsedRanges.push({ start: item[0], end: item[1], sourceId: groupSourceId, policy: groupPolicy });
          }
          nextOverrides = {
            ranges: upsertOverrideRanges(nextOverrides.ranges, parsedRanges),
            keys: nextOverrides.keys,
          };
        }
        if (group.keys !== undefined) {
          if (!Array.isArray(group.keys) || !group.keys.every((item): item is string => typeof item === "string")) {
            throw new Error("The saved download recovery policy is invalid.");
          }
          nextOverrides = upsertOverrideEntries(
            nextOverrides,
            group.keys.map(key => ({ key, sourceId: groupSourceId, policy: groupPolicy })),
          );
        }
      }
    }

    const nextEpisodes = new Map<string, RecoveryEpisode>();
    for (const row of value.episodes) {
      if (
        !record(row) || typeof row.key !== "string" || typeof row.sourceId !== "string" ||
        typeof row.title !== "string" || typeof row.policyIndex !== "number" ||
        !Number.isSafeInteger(row.policyIndex) || !policies[row.policyIndex]
      ) {
        throw new Error("The saved download recovery episode is invalid.");
      }
      const policy = policies[row.policyIndex]!;
      nextEpisodes.set(row.key, parseEpisodeRow(row, { sourceId: row.sourceId, title: row.title, policy }));
    }

    const nextSiteResets = new Set<string>();
    if (Array.isArray(value.siteResets)) {
      for (const origin of value.siteResets) {
        if (typeof origin === "string" && originOf(origin) === origin) nextSiteResets.add(origin);
      }
    }

    this.sourcePolicies = nextSourcePolicies;
    this.overrides = nextOverrides;
    this.episodes = nextEpisodes;
    this.siteResets = nextSiteResets;
    this.lastPersistedJson = raw;
    for (const sourceId of nextSourcePolicies.keys()) this.restoredSourcePolicies.add(sourceId);
    for (const [key, episode] of nextEpisodes) {
      this.setRegistration(key, { sourceId: episode.sourceId, title: episode.title, policy: episode.policy });
    }
    this.publish();
  }

  private assertLoaded(): void {
    this.load();
    if (this.loadError) throw new ChapterStorageError("Read download recovery state", this.loadError);
  }

  private commitPersistedState(
    nextState: PersistedState,
    applyMemory?: () => void,
    options: { publish?: boolean } = {},
  ): void {
    this.assertLoaded();
    if (!this.storage) {
      if (nextState.episodes.size > 0) {
        throw new ChapterStorageError("Save download recovery state", new Error("Browser storage is unavailable."));
      }
      this.sourcePolicies = nextState.sourcePolicies;
      this.overrides = nextState.overrides;
      this.episodes = nextState.episodes;
      this.siteResets = nextState.siteResets;
      applyMemory?.();
      if (options.publish !== false) this.publish();
      return;
    }
    const serialized = serializePersistedState(nextState);
    const empty = nextState.episodes.size === 0 && nextState.siteResets.size === 0 &&
      nextState.sourcePolicies.size === 0 && nextState.overrides.ranges.length === 0 && nextState.overrides.keys.size === 0;
    if (serialized !== this.lastPersistedJson && !(empty && this.lastPersistedJson === null)) {
      try {
        this.storage.setItem(DOWNLOAD_RECOVERY_STORAGE_KEY, serialized);
      } catch (error) {
        throw new ChapterStorageError("Save download recovery state", error);
      }
      this.lastPersistedJson = serialized;
    }
    this.sourcePolicies = nextState.sourcePolicies;
    this.overrides = nextState.overrides;
    this.episodes = nextState.episodes;
    this.siteResets = nextState.siteResets;
    applyMemory?.();
    if (options.publish !== false) this.publish();
  }

  private commitEpisode(key: string, episode: RecoveryEpisode, extraSiteResetOrigin?: string | null): void {
    const nextEpisodes = new Map(this.episodes);
    nextEpisodes.set(key, episode);
    const nextSiteResets = new Set(this.siteResets);
    if (extraSiteResetOrigin) nextSiteResets.add(extraSiteResetOrigin);
    this.commitPersistedState({
      sourcePolicies: new Map(this.sourcePolicies),
      overrides: cloneOverrides(this.overrides),
      episodes: nextEpisodes,
      siteResets: nextSiteResets,
    });
  }

  private publish(): void {
    this.snapshot = [...this.episodes.values()].map(({
      policy: _policy,
      usedProfileIds: _profiles,
      resetApplied: _reset,
      currentProfileId: _profile,
      currentProfileHash: _hash,
      ...state
    }) => ({ ...state }));
    for (const listener of this.listeners) listener();
  }

  /** Rebind a composed chapter's recovery to its original source without resetting its budget or hold. */
  setSource(job: DownloadRecoveryJob): void {
    this.assertLoaded();
    const key = downloadRecoveryKey(job);
    const registration = this.registrations.get(key);
    if (!registration || registration.sourceId === job.pluginId) return;
    const oldSourceId = registration.sourceId;
    const newSourceId = job.pluginId;
    const nextSourcePolicies = new Map(this.sourcePolicies);
    const nextEpisodes = new Map(this.episodes);
    const episode = nextEpisodes.get(key);
    if (episode) nextEpisodes.set(key, { ...episode, sourceId: newSourceId });

    let nextOverrides = deleteOverridesByKeys(this.overrides, [key]);
    if (!nextSourcePolicies.has(newSourceId)) {
      nextSourcePolicies.set(newSourceId, registration.policy);
    } else if (!episode && !policiesEqual(registration.policy, nextSourcePolicies.get(newSourceId)!)) {
      nextOverrides = upsertOverrideEntries(nextOverrides, [{ key, sourceId: newSourceId, policy: registration.policy }]);
    }

    const remainingOld = (this.sourceRegistrationCounts.get(oldSourceId) ?? 0) - 1;
    if (
      remainingOld <= 0 &&
      !this.restoredSourcePolicies.has(oldSourceId) &&
      !sourceHasEpisode(nextEpisodes, oldSourceId) &&
      !sourceHasOverrides(nextOverrides, oldSourceId)
    ) {
      nextSourcePolicies.delete(oldSourceId);
    }

    this.commitPersistedState(
      {
        sourcePolicies: nextSourcePolicies,
        overrides: nextOverrides,
        episodes: nextEpisodes,
        siteResets: new Set(this.siteResets),
      },
      () => {
        this.setRegistration(key, { ...registration, sourceId: newSourceId });
      },
      { publish: Boolean(episode) },
    );
  }

  register(jobs: readonly DownloadRecoveryJob[], policy = getDownloadRecoveryPolicy()): void {
    this.assertLoaded();
    if (jobs.length === 0) return;
    const normalizedPolicy = normalizeDownloadRecoveryPolicy(policy);
    const added: { key: string; registration: RecoveryRegistration }[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      const key = downloadRecoveryKey(job);
      if (this.registrations.has(key) || seen.has(key)) continue;
      seen.add(key);
      added.push({ key, registration: { sourceId: job.pluginId, title: job.title, policy: normalizedPolicy } });
    }
    if (added.length === 0) return;

    const nextSourcePolicies = new Map(this.sourcePolicies);
    const overrideAdditions: { key: string; sourceId: string; policy: DownloadRecoveryPolicy }[] = [];
    const overrideRemovals: string[] = [];
    for (const { key, registration } of added) {
      const baseline = nextSourcePolicies.get(registration.sourceId);
      if (!baseline) {
        nextSourcePolicies.set(registration.sourceId, registration.policy);
        overrideRemovals.push(key);
      } else if (!policiesEqual(baseline, registration.policy)) {
        overrideAdditions.push({ key, sourceId: registration.sourceId, policy: registration.policy });
      } else {
        overrideRemovals.push(key);
      }
    }
    let nextOverrides = overrideRemovals.length
      ? deleteOverridesByKeys(this.overrides, overrideRemovals)
      : cloneOverrides(this.overrides);
    if (overrideAdditions.length) {
      nextOverrides = upsertOverrideEntries(nextOverrides, overrideAdditions);
    }

    this.commitPersistedState(
      {
        sourcePolicies: nextSourcePolicies,
        overrides: nextOverrides,
        episodes: new Map(this.episodes),
        siteResets: new Set(this.siteResets),
      },
      () => {
        for (const { key, registration } of added) {
          this.setRegistration(key, registration);
        }
      },
      { publish: false },
    );
  }

  /**
   * Rehydrates in-memory registrations for persisted queued jobs using their snapshotted
   * recovery policies (active episode -> per-key override -> source baseline -> current policy)
   * without writing to storage.
   */
  restore(jobs: readonly DownloadRecoveryJob[]): void {
    this.assertLoaded();
    if (jobs.length === 0) return;
    const fallbackPolicy = getDownloadRecoveryPolicy();
    for (const job of jobs) {
      const key = downloadRecoveryKey(job);
      if (this.registrations.has(key)) continue;
      const override = lookupOverride(this.overrides, key);
      const policy = override?.policy ?? this.sourcePolicies.get(job.pluginId) ?? fallbackPolicy;
      this.setRegistration(key, { sourceId: job.pluginId, title: job.title, policy });
    }
  }

  /**
   * Prunes stale registrations, policy overrides, and idle source policies that are no
   * longer backed by any active queued/pending/VPN job or active recovery episode.
   */
  prune(activeKeys: ReadonlySet<string>, activeSourceIds?: ReadonlySet<string>): void {
    this.assertLoaded();
    const nextSourcePolicies = new Map(this.sourcePolicies);
    const nextEpisodes = new Map(this.episodes);
    const nextSiteResets = new Set(this.siteResets);

    const staleRegistrationKeys: string[] = [];
    const remainingSourceIds = new Set<string>(activeSourceIds);
    for (const [key, registration] of this.registrations) {
      if (activeKeys.has(key) || nextEpisodes.has(key)) {
        remainingSourceIds.add(registration.sourceId);
      } else {
        staleRegistrationKeys.push(key);
      }
    }
    for (const episode of nextEpisodes.values()) {
      remainingSourceIds.add(episode.sourceId);
    }

    const nextOverrides = pruneOverrides(this.overrides, activeKeys, nextEpisodes);
    for (const range of nextOverrides.ranges) remainingSourceIds.add(range.sourceId);
    for (const entry of nextOverrides.keys.values()) remainingSourceIds.add(entry.sourceId);

    for (const sourceId of nextSourcePolicies.keys()) {
      if (!remainingSourceIds.has(sourceId)) {
        nextSourcePolicies.delete(sourceId);
      }
    }

    this.commitPersistedState(
      {
        sourcePolicies: nextSourcePolicies,
        overrides: nextOverrides,
        episodes: nextEpisodes,
        siteResets: nextSiteResets,
      },
      () => {
        this.restoredSourcePolicies.clear();
        for (const key of staleRegistrationKeys) {
          this.deleteRegistration(key);
        }
      },
      { publish: false },
    );
  }

  /** Only an explicit resume adopts changed settings and starts another episode. */
  resume(sourceId?: string, keys?: ReadonlySet<string>): void {
    this.assertLoaded();
    const policy = getDownloadRecoveryPolicy();
    const nextEpisodes = new Map(this.episodes);
    const nextSiteResets = new Set(this.siteResets);
    const nextSourcePolicies = new Map(this.sourcePolicies);
    let nextOverrides = cloneOverrides(this.overrides);
    const registrationUpdates: [string, RecoveryRegistration][] = [];

    if (!keys) {
      for (const [key, episode] of this.episodes) {
        if (sourceId && episode.sourceId !== sourceId) continue;
        if (episode.origin) nextSiteResets.delete(episode.origin);
        nextEpisodes.delete(key);
      }
      if (sourceId) {
        if (nextSourcePolicies.has(sourceId) || this.sourceRegistrationCounts.has(sourceId)) {
          nextSourcePolicies.set(sourceId, policy);
        }
        nextOverrides = deleteOverridesBySource(nextOverrides, sourceId);
      } else {
        for (const knownSourceId of nextSourcePolicies.keys()) {
          nextSourcePolicies.set(knownSourceId, policy);
        }
        nextOverrides = emptyOverrides();
      }
      for (const [key, registration] of this.registrations) {
        if (sourceId && registration.sourceId !== sourceId) continue;
        registrationUpdates.push([key, { ...registration, policy }]);
      }
    } else {
      const overrideAdditions: { key: string; sourceId: string; policy: DownloadRecoveryPolicy }[] = [];
      const overrideRemovals: string[] = [];
      const matchedBySource = new Map<string, number>();

      for (const key of keys) {
        const registration = this.registrations.get(key);
        const episode = this.episodes.get(key);
        const override = lookupOverride(this.overrides, key);
        const keySourceId =
          registration?.sourceId ??
          episode?.sourceId ??
          override?.sourceId ??
          (sourceId && nextSourcePolicies.has(sourceId) ? sourceId : undefined);
        if (!keySourceId || (sourceId && keySourceId !== sourceId)) continue;
        if (episode) {
          if (episode.origin) nextSiteResets.delete(episode.origin);
          nextEpisodes.delete(key);
        }
        if (registration) {
          registrationUpdates.push([key, { ...registration, policy }]);
          matchedBySource.set(keySourceId, (matchedBySource.get(keySourceId) ?? 0) + 1);
        }
        const baseline = nextSourcePolicies.get(keySourceId);
        if (baseline && !policiesEqual(baseline, policy)) {
          overrideAdditions.push({ key, sourceId: keySourceId, policy });
        } else {
          overrideRemovals.push(key);
        }
      }

      nextOverrides = deleteOverridesByKeys(nextOverrides, overrideRemovals);
      nextOverrides = upsertOverrideEntries(nextOverrides, overrideAdditions);

      for (const [matchedSourceId, count] of matchedBySource) {
        if (
          !this.restoredSourcePolicies.has(matchedSourceId) &&
          count === (this.sourceRegistrationCounts.get(matchedSourceId) ?? 0) &&
          !sourceHasEpisode(nextEpisodes, matchedSourceId)
        ) {
          nextSourcePolicies.set(matchedSourceId, policy);
          nextOverrides = deleteOverridesBySource(nextOverrides, matchedSourceId);
        }
      }
    }

    this.commitPersistedState(
      {
        sourcePolicies: nextSourcePolicies,
        overrides: nextOverrides,
        episodes: nextEpisodes,
        siteResets: nextSiteResets,
      },
      () => {
        for (const [key, registration] of registrationUpdates) {
          this.setRegistration(key, registration);
        }
      },
    );
  }

  forget(keys: Iterable<string>, recovered = false): void {
    this.assertLoaded();
    const targetKeys: string[] = [];
    const seen = new Set<string>();
    const removedBySource = new Map<string, number>();
    let touched = false;

    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const registration = this.registrations.get(key);
      const episode = this.episodes.get(key);
      const override = lookupOverride(this.overrides, key);
      if (!registration && !episode && !override) continue;
      touched = true;
      targetKeys.push(key);
      if (registration) {
        removedBySource.set(registration.sourceId, (removedBySource.get(registration.sourceId) ?? 0) + 1);
      }
    }
    if (!touched) return;

    const nextEpisodes = new Map(this.episodes);
    const nextSiteResets = new Set(this.siteResets);
    const nextSourcePolicies = new Map(this.sourcePolicies);
    const affectedSources = new Set<string>(removedBySource.keys());
    let episodesChanged = false;

    for (const key of targetKeys) {
      const episode = nextEpisodes.get(key);
      if (episode) {
        affectedSources.add(episode.sourceId);
        if (recovered && episode.origin && episode.siteResetCount) nextSiteResets.delete(episode.origin);
        nextEpisodes.delete(key);
        episodesChanged = true;
      }
      const override = lookupOverride(this.overrides, key);
      if (override) affectedSources.add(override.sourceId);
    }

    const nextOverrides = deleteOverridesByKeys(this.overrides, targetKeys);

    for (const affectedSourceId of affectedSources) {
      const remaining = (this.sourceRegistrationCounts.get(affectedSourceId) ?? 0) - (removedBySource.get(affectedSourceId) ?? 0);
      if (
        remaining <= 0 &&
        !this.restoredSourcePolicies.has(affectedSourceId) &&
        !sourceHasEpisode(nextEpisodes, affectedSourceId) &&
        !sourceHasOverrides(nextOverrides, affectedSourceId)
      ) {
        nextSourcePolicies.delete(affectedSourceId);
      }
    }

    this.commitPersistedState(
      {
        sourcePolicies: nextSourcePolicies,
        overrides: nextOverrides,
        episodes: nextEpisodes,
        siteResets: nextSiteResets,
      },
      () => {
        for (const key of targetKeys) {
          this.deleteRegistration(key);
        }
      },
      { publish: episodesChanged },
    );
  }

  /** Forgets registrations for jobs that left the queue without an active recovery episode. */
  forgetIdle(keys: Iterable<string>): void {
    this.assertLoaded();
    const idleKeys: string[] = [];
    for (const key of keys) {
      if (!this.episodes.has(key)) idleKeys.push(key);
    }
    if (idleKeys.length > 0) this.forget(idleKeys);
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
    const nextEpisode: RecoveryEpisode = {
      key, sourceId: registration.sourceId, title: registration.title, policy: registration.policy,
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
    };
    this.commitEpisode(key, nextEpisode);
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
    /** Runs before source recovery or traffic on every attempt; server/local work may finish without source access. */
    beforeAttempt?: (context: TaskRunContext) => Promise<{ handled: false } | { handled: true; value: T }>;
  }, context: TaskRunContext, operation: (context: TaskRunContext) => Promise<T>): Promise<T> {
    const key = downloadRecoveryKey(options.job);
    this.assertLoaded();
    this.register([options.job], options.policy ?? this.policyFor(options.job));
    const currentRegistration = (): RecoveryRegistration =>
      this.registrations.get(key) ?? {
        sourceId: options.job.pluginId,
        title: options.job.title,
        policy: options.policy ? normalizeDownloadRecoveryPolicy(options.policy) : this.policyFor(options.job),
      };
    let currentUrl = options.url;
    const originalSetUrl = context.setSourceAccessUrl;
    let deferred = false;
    const attemptContext: TaskRunContext = { ...context, setSourceAccessUrl: url => {
      currentUrl = url;
      return originalSetUrl?.(url) ?? true;
    }, ...(context.tryStartSourceAccess ? { tryStartSourceAccess: route => {
      const started = route ? context.tryStartSourceAccess!(route) : context.tryStartSourceAccess!();
      deferred ||= !started;
      return started;
    } } : {}) };
    const prepare = async () => {
      context.signal.throwIfAborted();
      deferred = false;
      let result: { handled: false } | { handled: true; value: T } | undefined;
      try {
        result = await options.beforeAttempt?.(attemptContext);
      } catch (error) {
        if (!context.signal.aborted && !isAbortError(error) && !this.episodes.has(key) && !options.retainOnSuccess) {
          try {
            this.forget([key]);
          } catch {
            // Preserve the original beforeAttempt error when storage cleanup fails.
          }
        }
        throw error;
      }
      context.signal.throwIfAborted();
      if (result?.handled && !deferred && !options.retainOnSuccess) this.forget([key], true);
      return result;
    };
    let recovering = false;
    const execute = async (): Promise<T> => {
      for (;;) {
        const prepared = await prepare();
        if (prepared?.handled) return prepared.value;
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
          // A server copy may have arrived while recovery waited. Check again before
          // resetting source state, changing its VPN route, or making another request.
          const rechecked = await prepare();
          if (rechecked?.handled) return rechecked.value;
          episode = this.episodes.get(key);
          if (!episode) continue;
          if (episode.status === "held") throw new DownloadRecoveryHoldError(episode.error);

          let draft: RecoveryEpisode = { ...episode, usedProfileIds: [...episode.usedProfileIds] };
          if (draft.action !== "nextProfile" && options.vpn && draft.currentProfileId) {
            const profile = await options.profileId?.();
            const hash = options.profileHash?.();
            if (profile !== draft.currentProfileId || (hash && draft.currentProfileHash && hash !== draft.currentProfileHash)) {
              draft = {
                ...draft,
                status: "held",
                error: "The original VPN profile changed. Resume explicitly before retrying.",
              };
              this.commitEpisode(key, draft);
              throw new DownloadRecoveryHoldError(draft.error);
            }
          }
          if (draft.action === "nextProfile") {
            const profile = await options.profileId?.();
            if (!profile || draft.usedProfileIds.includes(profile)) {
              draft = { ...draft, status: "switching-profile", nextRetryAt: null };
              this.commitEpisode(key, draft);
              throw new DownloadRecoveryNextProfileError(key, draft.usedProfileIds);
            }
            draft = {
              ...draft,
              usedProfileIds: [...draft.usedProfileIds, profile],
              currentProfileId: profile,
              currentProfileHash: options.profileHash?.() ?? null,
              action: "retry",
            };
          }
          if (draft.action === "resetSite" && !draft.resetApplied) {
            draft = { ...draft, status: "resetting" };
            this.commitEpisode(key, draft);
            try {
              context.signal.throwIfAborted();
              const reset = options.resetSite ?? (await import("../site-browser/session")).resetSourceSiteData;
              await reset(currentRegistration().sourceId, draft.origin!);
              draft = { ...draft, resetApplied: true };
              this.commitEpisode(key, draft);
              context.signal.throwIfAborted();
            } catch (error) {
              const heldError = isAbortError(error) || context.signal.aborted
                ? "Site reset was interrupted. Resume explicitly before retrying."
                : `Site reset failed: ${classifyDownloadFailure(error).summary}`;
              draft = { ...draft, status: "held", error: heldError };
              this.commitEpisode(key, draft);
              throw isAbortError(error) || context.signal.aborted ? error : new DownloadRecoveryHoldError(heldError, error);
            }
          }
          draft = { ...draft, status: "retrying", nextRetryAt: null };
          this.commitEpisode(key, draft);
          episode = draft;
          context.setDetail("Retrying download with the selected recovery policy.");
        }
        try {
          deferred = false;
          const value = await operation(attemptContext);
          context.signal.throwIfAborted();
          if (!deferred && !options.retainOnSuccess) this.forget([key], true);
          else if (deferred && episode) {
            const latest = this.episodes.get(key);
            if (latest) this.commitEpisode(key, { ...latest, status: "waiting" });
          }
          return value;
        } catch (error) {
          if (context.signal.aborted || isAbortError(error) || isDownloadRecoveryReconnect(error) || isDownloadRecoveryNextProfile(error)) throw error;
          const failure = classifyDownloadFailure(error);
          if (failure.failureClass === "storage") throw error;
          const registration = currentRegistration();
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
          const notFoundPolicyHold =
            isHttpNotFoundError(error) ||
            (registration.policy.notFoundAction === "pause" &&
              isChapterMediaIncompleteError(error) &&
              error.failures.some(isHttpNotFoundError));
          if (
            decision.action === "pause" &&
            !notFoundPolicyHold &&
            (isSkippableIncompleteMediaFailure(error) || isChapterMediaVerificationFailure(error))
          ) {
            this.forget([key]);
            throw error;
          }
          const next: RecoveryEpisode = {
            key, sourceId: registration.sourceId, title: registration.title, policy: registration.policy, origin,
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
          // Persist the reservation before waiting, resetting site data, or selecting another VPN.
          this.commitEpisode(key, next, decision.action === "resetSite" ? origin : null);
          if (decision.action === "pause") {
            if (notFoundPolicyHold) throw new DownloadRecoveryHoldError(failure.summary, error);
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
export function initializeDownloadRecovery(): void {
  downloadRecovery.getSnapshot();
}
