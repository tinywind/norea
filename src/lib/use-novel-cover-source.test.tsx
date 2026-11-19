import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "./android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  acquireCachedNovelCoverSource: vi.fn(),
  clearNovelCoverDisplayCache: vi.fn(),
  metadataListeners: new Set<(identity?: { pluginId: string; novelPath: string }) => void>(),
  peekCachedNovelCoverSrc: vi.fn<() => string | null | undefined>(() => "blob:already-loaded-cover"),
}));

vi.mock("./novel-cover-storage", () => ({
  getNovelCoverSnapshot: () => 0,
  peekCachedNovelCoverSrc: mocks.peekCachedNovelCoverSrc,
  persistCachedNovelCoverSource: vi.fn(),
  subscribeNovelCoverChanges: () => () => undefined,
  acquireCachedNovelCoverSource: mocks.acquireCachedNovelCoverSource,
  clearNovelCoverDisplayCache: mocks.clearNovelCoverDisplayCache,
}));
vi.mock("./plugins/manager", () => ({
  pluginManager: {
    getPlugin: () => ({ id: "demo" }),
    loadInstalledFromDb: vi.fn(async () => undefined),
  },
}));
vi.mock("./work-metadata", () => ({
  subscribeWorkMetadataChanges: (
    listener: (identity?: { pluginId: string; novelPath: string }) => void,
  ) => {
    mocks.metadataListeners.add(listener);
    return () => {
      mocks.metadataListeners.delete(listener);
    };
  },
}));

import { useNovelCoverSource } from "./use-novel-cover-source";

let harness: BackNavigationHarness | undefined;

beforeEach(() => {
  mocks.metadataListeners.clear();
  mocks.clearNovelCoverDisplayCache.mockReset();
  mocks.acquireCachedNovelCoverSource.mockReset();
  mocks.peekCachedNovelCoverSrc.mockReset().mockReturnValue("blob:already-loaded-cover");
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

it("shows a previously loaded browse cover on the first render without a database id", () => {
  function Cover() {
    const src = useNovelCoverSource({ id: 0, pluginId: "demo", sourceNovelId: null, path: "/book", name: "Book", cover: "/cover.jpg" }, { allowSourceFallback: true });
    return <span data-cover={src} />;
  }
  expect(renderToStaticMarkup(<Cover />)).toContain('data-cover="blob:already-loaded-cover"');
});

it("does not clear an in-flight browse cover on a global metadata recovery event, but retries settled placeholders", async () => {
  let resolveCover!: (value: string | null) => void;
  mocks.peekCachedNovelCoverSrc.mockReturnValue(undefined);
  mocks.acquireCachedNovelCoverSource
    .mockImplementationOnce(() => ({
      promise: new Promise<string | null>((resolve) => {
        resolveCover = resolve;
      }),
      release: vi.fn(),
    }))
    .mockImplementationOnce(() => ({
      promise: Promise.resolve("blob:recovered-cover"),
      release: vi.fn(),
    }));

  let observed: string | null = null;
  function Probe() {
    observed = useNovelCoverSource(
      { id: 0, pluginId: "demo", sourceNovelId: null, path: "/book", name: "Book", cover: "/cover.jpg" },
      { allowSourceFallback: true },
    );
    return null;
  }

  harness = mountBackNavigationHarness();
  await harness.render(<Probe />);
  expect(mocks.acquireCachedNovelCoverSource).toHaveBeenCalledTimes(1);

  await harness.run(() => {
    for (const listener of mocks.metadataListeners) listener(undefined);
  });
  expect(mocks.clearNovelCoverDisplayCache).not.toHaveBeenCalled();
  expect(mocks.acquireCachedNovelCoverSource).toHaveBeenCalledTimes(1);

  await harness.run(async () => {
    resolveCover(null);
    await Promise.resolve();
  });
  expect(observed).toBeNull();

  await harness.run(() => {
    for (const listener of mocks.metadataListeners) listener(undefined);
  });
  expect(mocks.clearNovelCoverDisplayCache).toHaveBeenCalledExactlyOnceWith(0, {
    pluginId: "demo",
    path: "/book",
  });
  expect(mocks.acquireCachedNovelCoverSource).toHaveBeenCalledTimes(2);
  expect(observed).toBe("blob:recovered-cover");
});
