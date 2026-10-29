import {
  isSourceAccessRequiredError,
  sourceAccessScopeKey,
  type SourceAccessChallenge,
} from "../plugins/source-access";

export interface SourceAccessBlock {
  challenge: SourceAccessChallenge;
  challengeUrlRedacted?: boolean;
  detectedAt: number;
  originTaskId?: string;
  originTaskKey?: string;
  revision: number;
  scopeKey: string;
  sourceId: string;
  verificationError?: string;
  verificationRequested: boolean;
  verificationTaskId?: string;
}

export type SourceAccessBlockState = Readonly<SourceAccessBlock>;

interface SourceAccessChallengeOrigin {
  sourceId: string;
  taskId: string;
  taskKey: string | undefined;
}

export function normalizedSourceAccessUrl(
  value: string,
  scopeKey: string,
  sourceId: string,
): string | null {
  try {
    if (sourceAccessScopeKey(value, sourceId) !== scopeKey) return null;
    return new URL(value).href;
  } catch {
    return null;
  }
}

export function normalizedSourceAccessTaskKey(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key && key.length <= 512 ? key : undefined;
}

export class SourceAccessGate {
  private readonly blocks = new Map<string, SourceAccessBlock>();
  private revision = 0;

  get size(): number {
    return this.blocks.size;
  }

  get(scopeKey: string): SourceAccessBlockState | undefined {
    return this.blocks.get(scopeKey);
  }

  values(): IterableIterator<SourceAccessBlockState> {
    return this.blocks.values();
  }

  isBlocked(sourceId: string | undefined): boolean {
    for (const block of this.blocks.values()) {
      if (sourceId === block.sourceId) return true;
    }
    return false;
  }

  snapshot(): SourceAccessBlock[] {
    return [...this.blocks.values()]
      .map((block) => ({
        challenge: { ...block.challenge },
        ...(block.challengeUrlRedacted ? { challengeUrlRedacted: true } : {}),
        detectedAt: block.detectedAt,
        ...(block.originTaskId ? { originTaskId: block.originTaskId } : {}),
        ...(block.originTaskKey ? { originTaskKey: block.originTaskKey } : {}),
        revision: block.revision,
        scopeKey: block.scopeKey,
        sourceId: block.sourceId,
        ...(block.verificationError
          ? { verificationError: block.verificationError }
          : {}),
        verificationRequested: block.verificationRequested,
        ...(block.verificationTaskId
          ? { verificationTaskId: block.verificationTaskId }
          : {}),
      }))
      .sort((left, right) => left.detectedAt - right.detectedAt);
  }

  recordChallenge(
    scopeKey: string,
    challenge: SourceAccessChallenge,
    origin: Readonly<SourceAccessChallengeOrigin>,
    verificationError: string,
  ): {
    block: SourceAccessBlockState;
    revokedVerificationTaskId: string | undefined;
  } {
    const existing = this.blocks.get(scopeKey);
    const invalidatesVerification = Boolean(
      existing?.verificationRequested || existing?.verificationTaskId,
    );
    const challengeChanged = Boolean(
      existing &&
      (existing.sourceId !== origin.sourceId ||
        existing.challenge.kind !== challenge.kind ||
        existing.challenge.url !== challenge.url),
    );
    const replacesChallenge = invalidatesVerification || challengeChanged;
    const originTaskKey =
      replacesChallenge || !existing
        ? normalizedSourceAccessTaskKey(origin.taskKey)
        : existing.originTaskKey;
    const revision =
      !existing || replacesChallenge ? this.nextRevision() : existing.revision;
    const block: SourceAccessBlock = {
      challenge: { ...challenge },
      detectedAt: Date.now(),
      originTaskId:
        !existing || replacesChallenge ? origin.taskId : existing.originTaskId,
      ...(originTaskKey ? { originTaskKey } : {}),
      revision,
      scopeKey,
      sourceId: origin.sourceId,
      ...(invalidatesVerification
        ? { verificationError }
        : !challengeChanged && existing?.verificationError
          ? { verificationError: existing.verificationError }
          : {}),
      verificationRequested: false,
    };
    this.blocks.set(scopeKey, block);
    return { block, revokedVerificationTaskId: existing?.verificationTaskId };
  }

  replaceOriginTaskId(previousTaskId: string, nextTaskId: string): void {
    for (const block of this.blocks.values()) {
      if (block.originTaskId === previousTaskId) block.originTaskId = nextTaskId;
    }
  }

  hydrate(blocks: Iterable<SourceAccessBlock>): void {
    const hydrated = new Map<string, SourceAccessBlock>();
    let highestRevision = this.revision;
    for (const block of blocks) {
      const scopeKey = block.scopeKey?.trim();
      const sourceId = block.sourceId?.trim();
      const revision = Math.floor(block.revision);
      if (
        !scopeKey ||
        !sourceId ||
        !Number.isFinite(block.detectedAt) ||
        !Number.isFinite(revision) ||
        revision <= 0 ||
        !isSourceAccessRequiredError({
          challenge: block.challenge,
          code: "source-access-required",
        })
      ) {
        continue;
      }
      try {
        if (sourceAccessScopeKey(block.challenge.url, sourceId) !== scopeKey) continue;
      } catch {
        continue;
      }
      const current = hydrated.get(scopeKey);
      if (current && current.revision > revision) continue;
      const originTaskKey = normalizedSourceAccessTaskKey(block.originTaskKey);
      hydrated.set(scopeKey, {
        challenge: { ...block.challenge },
        ...(block.challengeUrlRedacted ? { challengeUrlRedacted: true } : {}),
        detectedAt: block.detectedAt,
        ...(originTaskKey ? { originTaskKey } : {}),
        revision,
        scopeKey,
        sourceId,
        ...(typeof block.verificationError === "string" &&
        block.verificationError.trim()
          ? { verificationError: block.verificationError }
          : {}),
        verificationRequested: false,
      });
      highestRevision = Math.max(highestRevision, revision);
    }
    this.blocks.clear();
    for (const [scopeKey, block] of hydrated) this.blocks.set(scopeKey, block);
    this.revision = highestRevision;
  }

  requestVerification(scopeKey: string): void {
    const block = this.blocks.get(scopeKey);
    if (!block) return;
    this.blocks.set(scopeKey, {
      ...block,
      verificationError: undefined,
      verificationRequested: true,
    });
  }

  prepareVerification(scopeKey: string, taskId: string | undefined): void {
    const block = this.blocks.get(scopeKey);
    if (!block) return;
    this.blocks.set(scopeKey, {
      ...block,
      verificationRequested: false,
      ...(taskId ? { verificationTaskId: taskId } : {}),
    });
  }

  matchesVerification(
    scopeKey: string,
    taskId: string,
    revision: number,
  ): boolean {
    const block = this.blocks.get(scopeKey);
    return Boolean(
      block &&
      block.revision === revision &&
      block.verificationTaskId === taskId,
    );
  }

  stopVerification(
    scopeKey: string,
    verificationError?: string,
  ): number | null {
    const block = this.blocks.get(scopeKey);
    if (!block) return null;
    const revision = this.nextRevision();
    this.blocks.set(scopeKey, {
      ...block,
      revision,
      ...(verificationError !== undefined ? { verificationError } : {}),
      verificationRequested: false,
      verificationTaskId: undefined,
    });
    return revision;
  }

  refreshChallengeUrl(
    scopeKey: string,
    url: string,
    originTaskId: string,
    originTaskKey: string | undefined,
  ): void {
    const block = this.blocks.get(scopeKey);
    if (!block) return;
    this.blocks.set(scopeKey, {
      ...block,
      challenge: { ...block.challenge, url },
      challengeUrlRedacted: undefined,
      originTaskId,
      originTaskKey: normalizedSourceAccessTaskKey(originTaskKey),
    });
  }

  clear(scopeKey: string): void {
    this.blocks.delete(scopeKey);
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }
}
