import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../db/queries/chapter", () => ({
  getChapterById: vi.fn(), markChapterOpened: vi.fn(async () => undefined), updateChapterProgress: vi.fn(async () => undefined),
}));
vi.mock("../../db/user-state", () => ({ recordUserResume: vi.fn(async () => undefined) }));
vi.mock("../../lib/reader-query-invalidation", () => ({
  chapterDetailQueryKey: (id: number) => ["chapter", id],
  chapterListQueryKey: (id: number) => ["chapter-list", id],
  novelChaptersQueryKey: (id: number) => ["novel-chapters", id],
  invalidateReaderOpenedQueries: vi.fn(async () => undefined),
  invalidateReaderProgressQueries: vi.fn(async () => undefined),
}));
vi.mock("../../lib/updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));
vi.mock("../../lib/user-state/events", () => ({ requestUserStateFlush: vi.fn() }));

const saved = new Map<string, string>();
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
  removeItem: (key: string) => saved.delete(key),
};
vi.stubGlobal("localStorage", storage);
vi.stubGlobal("window", { localStorage: storage });
const { useReaderPersistence } = await import("./use-reader-persistence");
const { useContentSyncStore } = await import("../../store/content-sync");
const { useReaderStore } = await import("../../store/reader");
const { useLibraryStore } = await import("../../store/library");
const { useUserStateStore } = await import("../../store/user-state");
const { markChapterOpened, updateChapterProgress } = await import("../../db/queries/chapter");
const { recordUserResume } = await import("../../db/user-state");
const { requestUserStateFlush } = await import("../../lib/user-state/events");
const { registerBeforeAppSuspend, runBeforeAppSuspend } = await import("../../lib/app-lifecycle");
const { getSyncRuntimeSnapshot, resetSyncRuntimeForTests } = await import("../../lib/tasks/sync-runtime");

let root: Root | undefined;
let queryClient: QueryClient;
let current: ReturnType<typeof useReaderPersistence>;
const chapter = { id: 71, novelId: 7, content: "<p>Saved body</p>" };

function mount() {
  const document = {
    nodeType: 9, activeElement: null, body: null as unknown,
    documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {},
  };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, localStorage: storage, HTMLIFrameElement: class {} }));
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container as unknown as Element);
}
function Probe() {
  const opened = useRef<number | null>(null);
  current = useReaderPersistence(chapter, opened);
  return null;
}
async function render() {
  mount();
  await act(async () => root!.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>));
}

beforeEach(() => {
  saved.clear();
  resetSyncRuntimeForTests();
  useReaderStore.getState().resetReadingProgress();
  useLibraryStore.setState({ incognitoMode: false });
  useContentSyncStore.setState({ ...useContentSyncStore.getInitialState(), serverUrl: "http://server" });
  useUserStateStore.setState({ enabledByServer: { "http://server": true }, runtimeByServer: {} });
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (root) await act(async () => root!.unmount());
  root = undefined;
  queryClient?.clear();
  resetSyncRuntimeForTests();
  vi.unstubAllGlobals();
});

it("records a normal open and portable scroll anchor through the ledger API", async () => {
  await render();
  await vi.waitFor(() => expect(recordUserResume).toHaveBeenCalledWith(71, null, expect.any(Number)));
  expect(markChapterOpened).toHaveBeenCalledWith(71);
  expect(requestUserStateFlush).toHaveBeenCalledTimes(1);
  vi.mocked(recordUserResume).mockClear();
  await act(async () => useReaderStore.getState().setChapterScrollAnchor(71, {
    novelId: 7, segmentIndex: 2, segmentCount: 20, offset: 0.5, progress: 15,
  }));
  await vi.waitFor(() => expect(recordUserResume).toHaveBeenCalledWith(71, {
    segmentIndex: 2, segmentCount: 20, offset: 0.5, progress: 15, savedAt: expect.any(Number),
  }, expect.any(Number)));
});

it("does not publish an incognito open, progress change, or scroll anchor", async () => {
  useLibraryStore.setState({ incognitoMode: true });
  await render();
  await act(async () => {
    current.persistProgress({ chapterId: 71, novelId: 7, progress: 35 });
    useReaderStore.getState().setChapterScrollAnchor(71, {
      novelId: 7, segmentIndex: 4, segmentCount: 20, offset: 0.2, progress: 35,
    });
  });
  await vi.waitFor(() => expect(updateChapterProgress).toHaveBeenCalledWith(71, 35, { recordHistory: false }));
  expect(markChapterOpened).not.toHaveBeenCalled();
  expect(recordUserResume).not.toHaveBeenCalled();
});

it("does not echo a committed remote resume into a new local operation", async () => {
  await render();
  await vi.waitFor(() => expect(recordUserResume).toHaveBeenCalled());
  vi.mocked(recordUserResume).mockClear();
  await act(async () => useReaderStore.getState().applySharedResume({
    novelId: 7, chapterId: 71, openedAt: 123,
    anchor: { segmentIndex: 6, segmentCount: 20, offset: 0.3, progress: 40, savedAt: 123000 },
  }));
  expect(recordUserResume).not.toHaveBeenCalled();
});

it("captures privacy mode when the save is requested instead of publishing it after privacy mode changes", async () => {
  useLibraryStore.setState({ incognitoMode: true });
  await render();
  await act(async () => current.persistProgress({ chapterId: 71, novelId: 7, progress: 10 }));
  await act(async () => useLibraryStore.getState().setIncognitoMode(false));
  await vi.waitFor(() => expect(updateChapterProgress).toHaveBeenCalledWith(71, 10, { recordHistory: false }));
  expect(recordUserResume).not.toHaveBeenCalled();
});

it("passes allowProgressReset to reset a finished chapter on re-read movement and keeps finished chapters intact otherwise", async () => {
  await render();
  queryClient.setQueryData(["chapter", 71], { id: 71, novelId: 7, progress: 100, readAt: 500 });
  queryClient.setQueryData(["novel-chapters", 7], [{ id: 71, novelId: 7, progress: 100, readAt: 500 }]);

  await act(async () => current.persistProgress({ chapterId: 71, novelId: 7, progress: 18 }));
  await vi.waitFor(() => expect(updateChapterProgress).toHaveBeenCalledWith(71, 18, { recordHistory: true }));
  expect((queryClient.getQueryData(["chapter", 71]) as { progress: number }).progress).toBe(100);

  vi.mocked(updateChapterProgress).mockClear();
  await act(async () => current.persistProgress({ chapterId: 71, novelId: 7, progress: 22, allowProgressReset: true }));
  await vi.waitFor(() =>
    expect(updateChapterProgress).toHaveBeenCalledWith(71, 22, { recordHistory: true, allowProgressReset: true }),
  );
  expect((queryClient.getQueryData(["chapter", 71]) as { progress: number }).progress).toBe(22);
});

it("drains a progress mutation triggered during before-suspend flush and holds the pending upload hint continuously", async () => {
  await render();
  await vi.waitFor(() => expect(recordUserResume).toHaveBeenCalled());
  vi.mocked(updateChapterProgress).mockClear();
  vi.mocked(recordUserResume).mockClear();

  let finishProgressWrite!: () => void;
  vi.mocked(updateChapterProgress).mockImplementationOnce(
    () => new Promise<void>((resolve) => { finishProgressWrite = resolve; }),
  );

  let pendingHintRightAfterFlush = false;
  const unregisterFlush = registerBeforeAppSuspend(() => {
    current.persistProgress({ chapterId: 71, novelId: 7, progress: 65 });
    pendingHintRightAfterFlush = getSyncRuntimeSnapshot().hasPendingBackgroundUpload;
  }, "flush");

  try {
    let suspendFinished = false;
    let suspending!: Promise<void>;
    await act(async () => {
      suspending = runBeforeAppSuspend(5_000).then(() => { suspendFinished = true; });
      await vi.waitFor(() => expect(updateChapterProgress).toHaveBeenCalledWith(71, 65, { recordHistory: true }));
    });
    expect(pendingHintRightAfterFlush).toBe(true);
    expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(true);
    expect(suspendFinished).toBe(false);

    await act(async () => {
      finishProgressWrite();
      await suspending;
    });
    expect(suspendFinished).toBe(true);
    expect(recordUserResume).toHaveBeenCalledWith(71, null, expect.any(Number));
    expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(false);
  } finally {
    unregisterFlush();
  }
});
