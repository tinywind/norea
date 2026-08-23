import { describe, expect, it, vi } from "vitest";

import type { SourceAccessBlock } from "./scheduler";
import {
  SOURCE_ACCESS_STORAGE_KEY,
  applySourceAccessBrowserOutcome,
  loadPersistedSourceAccessBlocks,
  startSourceAccessPersistence,
} from "./source-access-coordinator";

function sourceAccessBlock(
  overrides: Partial<SourceAccessBlock> = {},
): SourceAccessBlock {
  return {
    challenge: {
      kind: "captcha",
      url: "https://source.test/signed/path-token/chapter/1?token=secret#proof",
    },
    detectedAt: 1_700_000_000_000,
    originTaskKey: "chapter.download:source-a:1",
    revision: 3,
    scopeKey: "site:source.test",
    sourceIds: ["source-a"],
    verificationRequested: false,
    ...overrides,
  };
}

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: vi.fn((key: string) =>
      key === SOURCE_ACCESS_STORAGE_KEY ? value : null,
    ),
    setItem: vi.fn((key: string, nextValue: string) => {
      if (key === SOURCE_ACCESS_STORAGE_KEY) value = nextValue;
    }),
    value: () => value,
  };
}

describe("source access persistence", () => {
  it("loads valid blocks without restoring runtime state or URL secrets", () => {
    const storage = memoryStorage(
      JSON.stringify({
        version: 1,
        blocks: [
          {
            ...sourceAccessBlock(),
            originTaskId: "stale-origin",
            verificationRequested: true,
            verificationTaskId: "stale-verification",
          },
        ],
      }),
    );

    expect(loadPersistedSourceAccessBlocks(storage)).toEqual([
      sourceAccessBlock({
        challenge: {
          kind: "captcha",
          url: "https://source.test",
        },
        challengeUrlRedacted: true,
      }),
    ]);
  });

  it("strips query and fragment while persisting without mutating runtime state", () => {
    const runtimeBlock = sourceAccessBlock();
    const storage = memoryStorage();
    const scheduler = {
      getSnapshot: () => ({ sourceAccessBlocks: [runtimeBlock] }),
      hydrateSourceAccessBlocks: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };

    startSourceAccessPersistence(scheduler, storage);

    const persisted = JSON.parse(storage.value() ?? "null");
    expect(persisted.blocks[0].challenge.url).toBe(
      "https://source.test",
    );
    expect(persisted.blocks[0].challengeUrlRedacted).toBe(true);
    expect(runtimeBlock.challenge.url).toBe(
      "https://source.test/signed/path-token/chapter/1?token=secret#proof",
    );
  });

  it("drops an untrusted persisted origin task key", () => {
    const storage = memoryStorage(
      JSON.stringify({
        version: 1,
        blocks: [
          sourceAccessBlock({
            originTaskKey: "https://source.test/?token=secret",
          }),
        ],
      }),
    );

    const [block] = loadPersistedSourceAccessBlocks(storage);
    expect(block).toBeDefined();
    expect(block).not.toHaveProperty("originTaskKey");
  });

  it("persists every blocked scope", () => {
    const blocks = Array.from({ length: 102 }, (_, index) =>
      sourceAccessBlock({
        challenge: {
          kind: "captcha",
          url: `https://source-${index}.test/chapter/1`,
        },
        detectedAt: index,
        revision: index + 1,
        scopeKey: `site:source-${index}.test`,
      }),
    );
    const storage = memoryStorage();
    const scheduler = {
      getSnapshot: () => ({ sourceAccessBlocks: blocks }),
      hydrateSourceAccessBlocks: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };

    startSourceAccessPersistence(scheduler, storage);

    const persisted = JSON.parse(storage.value() ?? "null") as {
      blocks: SourceAccessBlock[];
    };
    expect(persisted.blocks).toHaveLength(102);
    expect(persisted.blocks[0]?.scopeKey).toBe("site:source-0.test");
    expect(persisted.blocks.at(-1)?.scopeKey).toBe("site:source-101.test");

    const restored = loadPersistedSourceAccessBlocks(storage);
    expect(restored).toHaveLength(102);
    expect(restored[0]?.scopeKey).toBe("site:source-0.test");
    expect(restored.at(-1)?.scopeKey).toBe("site:source-101.test");
  });

  it("fails closed to an empty list for unknown or invalid persisted data", () => {
    const unknownVersion = memoryStorage(
      JSON.stringify({ version: 2, blocks: [sourceAccessBlock()] }),
    );
    const mismatchedScope = memoryStorage(
      JSON.stringify({
        version: 1,
        blocks: [sourceAccessBlock({ scopeKey: "site:other.test" })],
      }),
    );

    expect(loadPersistedSourceAccessBlocks(unknownVersion)).toEqual([]);
    expect(loadPersistedSourceAccessBlocks(mismatchedScope)).toEqual([]);
  });

  it("hydrates before subscribing and persists later scheduler updates", () => {
    const persistedBlock = sourceAccessBlock();
    const hydratedBlock = sourceAccessBlock({
      challenge: {
        kind: "captcha",
        url: "https://source.test",
      },
      challengeUrlRedacted: true,
    });
    const storage = memoryStorage(
      JSON.stringify({ version: 1, blocks: [persistedBlock] }),
    );
    let blocks: SourceAccessBlock[] = [];
    let listener: () => void = () => undefined;
    const scheduler = {
      getSnapshot: () => ({ sourceAccessBlocks: blocks }),
      hydrateSourceAccessBlocks: vi.fn(
        (nextBlocks: Iterable<SourceAccessBlock>) => {
          blocks = [...nextBlocks];
        },
      ),
      subscribe: vi.fn((nextListener: () => void) => {
        listener = nextListener;
        return () => undefined;
      }),
    };

    startSourceAccessPersistence(scheduler, storage);

    expect(scheduler.hydrateSourceAccessBlocks).toHaveBeenCalledWith([
      hydratedBlock,
    ]);
    blocks = [];
    listener();
    expect(JSON.parse(storage.value() ?? "null")).toEqual({
      blocks: [],
      version: 1,
    });
  });

  it("does not crash when browser storage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
      setItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
    };

    expect(loadPersistedSourceAccessBlocks(storage)).toEqual([]);
  });

  it("applies browser outcomes only to the matching block revision", () => {
    const current = sourceAccessBlock();
    const scheduler = {
      beginSourceAccessVerification: vi.fn(() => true),
      getSnapshot: () => ({ sourceAccessBlocks: [current] }),
      keepSourceAccessBlocked: vi.fn(() => true),
    };

    expect(
      applySourceAccessBrowserOutcome(
        scheduler,
        sourceAccessBlock({ revision: current.revision - 1 }),
        "verify",
      ),
    ).toBe(false);
    expect(scheduler.beginSourceAccessVerification).not.toHaveBeenCalled();

    expect(
      applySourceAccessBrowserOutcome(scheduler, current, "keep-paused"),
    ).toBe(true);
    expect(scheduler.keepSourceAccessBlocked).toHaveBeenCalledWith(
      current.scopeKey,
    );

    expect(
      applySourceAccessBrowserOutcome(scheduler, current, "verify"),
    ).toBe(true);
    expect(scheduler.beginSourceAccessVerification).toHaveBeenCalledWith(
      current.scopeKey,
    );
  });

  it("accepts a verification outcome that already reserved its canary", () => {
    const current = sourceAccessBlock({ verificationRequested: true });
    const scheduler = {
      beginSourceAccessVerification: vi.fn(() => false),
      getSnapshot: () => ({ sourceAccessBlocks: [current] }),
      keepSourceAccessBlocked: vi.fn(() => true),
    };

    expect(
      applySourceAccessBrowserOutcome(scheduler, current, "verify"),
    ).toBe(true);
    expect(scheduler.beginSourceAccessVerification).not.toHaveBeenCalled();
  });
});
