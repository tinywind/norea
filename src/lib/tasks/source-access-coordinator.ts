import {
  isSourceAccessRequiredError,
  sourceAccessScopeKey,
} from "../plugins/source-access";
import { useSiteBrowserStore } from "../../store/site-browser";
import {
  enqueueSourceAccessBrowserTask,
  type SourceAccessBrowserOutcome,
} from "./source-tasks";
import {
  taskScheduler,
  type SourceAccessBlock,
  type TaskSnapshot,
} from "./scheduler";

export const SOURCE_ACCESS_STORAGE_KEY = "source-access-blocks";
const SOURCE_ACCESS_STORAGE_VERSION = 1;

interface SourceAccessStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface SourceAccessPersistenceScheduler {
  getSnapshot: () => Pick<TaskSnapshot, "sourceAccessBlocks">;
  hydrateSourceAccessBlocks: (blocks: Iterable<SourceAccessBlock>) => void;
  subscribe: (listener: () => void) => () => void;
}

interface SourceAccessOutcomeScheduler {
  beginSourceAccessVerification: (scopeKey: string) => boolean;
  getSnapshot: () => Pick<TaskSnapshot, "sourceAccessBlocks">;
  keepSourceAccessBlocked: (scopeKey: string) => boolean;
}

interface OpenSourceAccessBrowserOptions {
  sourceName: string;
  title: string;
}

interface PersistedSourceAccessState {
  blocks: SourceAccessBlock[];
  version: typeof SOURCE_ACCESS_STORAGE_VERSION;
}

function sourceAccessStorage(): SourceAccessStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function challengeUrlForPersistence(value: string): {
  redacted: boolean;
  url: string;
} {
  const url = new URL(value);
  return {
    redacted:
      url.pathname !== "/" || url.search !== "" || url.hash !== "",
    url: url.origin,
  };
}

function persistedOriginTaskKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return /^chapter\.download:[a-z0-9]+(?:-[a-z0-9]+)*:[1-9]\d*$/.test(key)
    ? key
    : undefined;
}

function persistedSourceAccessBlock(value: unknown): SourceAccessBlock | null {
  if (value === null || typeof value !== "object") return null;
  const block = value as Record<string, unknown>;
  const scopeKey = typeof block.scopeKey === "string" ? block.scopeKey.trim() : "";
  const revision =
    typeof block.revision === "number" ? Math.floor(block.revision) : 0;
  const detectedAt =
    typeof block.detectedAt === "number" ? block.detectedAt : Number.NaN;
  const accessError = {
    challenge: block.challenge,
    code: "source-access-required",
  };
  if (
    !scopeKey ||
    !Number.isFinite(detectedAt) ||
    !Number.isFinite(revision) ||
    revision <= 0 ||
    !isSourceAccessRequiredError(accessError)
  ) {
    return null;
  }
  const challenge = accessError.challenge;

  try {
    if (sourceAccessScopeKey(challenge.url) !== scopeKey) return null;
  } catch {
    return null;
  }

  const sourceIds = Array.isArray(block.sourceIds)
    ? [
        ...new Set(
          block.sourceIds
            .filter(
              (sourceId): sourceId is string => typeof sourceId === "string",
            )
            .map((sourceId) => sourceId.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const persistedChallengeUrl = challengeUrlForPersistence(challenge.url);
  const challengeUrlRedacted =
    block.challengeUrlRedacted === true || persistedChallengeUrl.redacted;
  const originTaskKey = persistedOriginTaskKey(block.originTaskKey);
  return {
    challenge: {
      kind: challenge.kind,
      url: persistedChallengeUrl.url,
    },
    ...(challengeUrlRedacted ? { challengeUrlRedacted: true } : {}),
    detectedAt,
    ...(originTaskKey ? { originTaskKey } : {}),
    revision,
    scopeKey,
    sourceIds,
    verificationRequested: false,
  };
}

function normalizedSourceAccessBlocks(value: unknown): SourceAccessBlock[] {
  if (!Array.isArray(value)) return [];
  const blocksByScope = new Map<string, SourceAccessBlock>();
  for (const candidate of value) {
    const block = persistedSourceAccessBlock(candidate);
    if (!block) continue;
    const current = blocksByScope.get(block.scopeKey);
    if (!current || block.revision >= current.revision) {
      blocksByScope.set(block.scopeKey, block);
    }
  }
  return [...blocksByScope.values()].sort(
    (left, right) => left.detectedAt - right.detectedAt,
  );
}

function serializedSourceAccessState(blocks: unknown): string {
  const state: PersistedSourceAccessState = {
    blocks: normalizedSourceAccessBlocks(blocks),
    version: SOURCE_ACCESS_STORAGE_VERSION,
  };
  return JSON.stringify(state);
}

export function loadPersistedSourceAccessBlocks(
  storage: SourceAccessStorage | null = sourceAccessStorage(),
): SourceAccessBlock[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SOURCE_ACCESS_STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return [];
    const state = value as Record<string, unknown>;
    if (state.version !== SOURCE_ACCESS_STORAGE_VERSION) return [];
    return normalizedSourceAccessBlocks(state.blocks);
  } catch {
    return [];
  }
}

export function startSourceAccessPersistence(
  scheduler: SourceAccessPersistenceScheduler = taskScheduler,
  storage: SourceAccessStorage | null = sourceAccessStorage(),
): () => void {
  scheduler.hydrateSourceAccessBlocks(loadPersistedSourceAccessBlocks(storage));
  let previous = "";
  const persist = () => {
    if (!storage) return;
    const serialized = serializedSourceAccessState(
      scheduler.getSnapshot().sourceAccessBlocks,
    );
    if (serialized === previous) return;
    try {
      storage.setItem(SOURCE_ACCESS_STORAGE_KEY, serialized);
      previous = serialized;
    } catch {
      // Source access still remains enforced in memory when storage is unavailable.
    }
  };
  persist();
  return scheduler.subscribe(persist);
}

let stopSourceAccessPersistence: (() => void) | null = null;

export function initializeSourceAccessCoordinator(): void {
  if (stopSourceAccessPersistence) return;
  stopSourceAccessPersistence = startSourceAccessPersistence();
}

function currentSourceAccessBlock(
  scheduler: Pick<SourceAccessOutcomeScheduler, "getSnapshot">,
  block: SourceAccessBlock,
): SourceAccessBlock | null {
  return (
    scheduler
      .getSnapshot()
      .sourceAccessBlocks.find(
        (candidate) =>
          candidate.scopeKey === block.scopeKey &&
          candidate.revision === block.revision,
      ) ?? null
  );
}

export function applySourceAccessBrowserOutcome(
  scheduler: SourceAccessOutcomeScheduler,
  block: SourceAccessBlock,
  outcome: SourceAccessBrowserOutcome,
): boolean {
  const current = currentSourceAccessBlock(scheduler, block);
  if (!current) return false;
  if (outcome === "keep-paused") {
    return scheduler.keepSourceAccessBlocked(block.scopeKey);
  }
  if (current.verificationRequested || current.verificationTaskId) return true;
  return scheduler.beginSourceAccessVerification(block.scopeKey);
}

let activeSourceAccessBrowserTaskId: string | null = null;
let sourceAccessBrowserOpening = false;

export async function openSourceAccessBrowser(
  block: SourceAccessBlock,
  options: OpenSourceAccessBrowserOptions,
): Promise<boolean> {
  if (
    sourceAccessBrowserOpening ||
    activeSourceAccessBrowserTaskId ||
    useSiteBrowserStore.getState().visible ||
    !currentSourceAccessBlock(taskScheduler, block) ||
    !taskScheduler.canBeginSourceAccessVerification(block.scopeKey)
  ) {
    return false;
  }

  sourceAccessBrowserOpening = true;
  try {
    const target = await taskScheduler.resolveSourceAccessVerificationUrl(
      block.scopeKey,
      block.revision,
    );
    const current = target
      ? taskScheduler
          .getSnapshot()
          .sourceAccessBlocks.find(
            (candidate) =>
              candidate.scopeKey === target.scopeKey &&
              candidate.revision === target.revision,
          )
      : undefined;
    if (
      !target ||
      !current ||
      activeSourceAccessBrowserTaskId ||
      useSiteBrowserStore.getState().visible ||
      !taskScheduler.canBeginSourceAccessVerification(target.scopeKey)
    ) {
      return false;
    }

    const resolvedBlock: SourceAccessBlock = {
      ...current,
      challenge: { ...current.challenge, url: target.url },
    };
    const sourceId = resolvedBlock.sourceIds[0] ?? resolvedBlock.scopeKey;
    const sourceName = options.sourceName.trim() || sourceId;
    const handle = enqueueSourceAccessBrowserTask(
      {
        getBaseUrl: () => target.url,
        id: sourceId,
        name: sourceName,
      },
      resolvedBlock,
      options.title,
    );
    activeSourceAccessBrowserTaskId = handle.id;
    void handle.promise
      .then((outcome) =>
        applySourceAccessBrowserOutcome(
          taskScheduler,
          resolvedBlock,
          outcome,
        ),
      )
      .catch(() => undefined)
      .finally(() => {
        if (activeSourceAccessBrowserTaskId === handle.id) {
          activeSourceAccessBrowserTaskId = null;
        }
      });
    return true;
  } finally {
    sourceAccessBrowserOpening = false;
  }
}

export function sourceAccessBlockSourceNames(
  block: SourceAccessBlock,
  snapshot: Pick<TaskSnapshot, "records"> = taskScheduler.getSnapshot(),
): string[] {
  const namesById = new Map<string, string>();
  for (const record of snapshot.records) {
    if (record.source) namesById.set(record.source.id, record.source.name);
  }
  return block.sourceIds.map((sourceId) => namesById.get(sourceId) ?? sourceId);
}
