import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => (() => void) | undefined)[],
  invalidateQueries: vi.fn(async () => undefined), server: vi.fn(), source: vi.fn(),
  setState: vi.fn(), serverUrl: "http://server",
}));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => { mocks.effects.push(effect); },
  useRef: (current: unknown) => ({ current }), useState: () => [null, mocks.setState],
}));
const queryClient = { invalidateQueries: mocks.invalidateQueries };
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => queryClient }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: (selector: (state: unknown) => unknown) => selector({ serverUrl: mocks.serverUrl }) }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/content-sync/work-refresh", () => ({ syncServerNovelOnOpen: mocks.server, refreshServerNovelFromSource: mocks.source }));
vi.mock("./novel-detail-model", () => ({ novelKey: (id: number) => ["novel", id], chaptersKey: (id: number) => ["novel", id, "chapters"] }));
import { useServerNovelSync } from "./use-server-novel-sync";

beforeEach(() => {
  vi.clearAllMocks(); mocks.effects.length = 0;
  mocks.server.mockReset().mockResolvedValue(true);
  mocks.source.mockReset().mockResolvedValue(true);
});

it("keeps rendering independent of pending work refresh and cancels on exit", async () => {
  let complete!: (value: boolean) => void;
  mocks.server.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  mocks.source.mockImplementation(() => new Promise(() => undefined));
  expect(useServerNovelSync(42, true, "Book")).toEqual({ serverError: null, sourceError: null });
  const cleanup = mocks.effects[0]!()!;
  const signal = mocks.server.mock.calls[0]![1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  cleanup(); complete(true);
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(mocks.source).toHaveBeenCalledWith(42, "tasks.task.refreshNovelMetadata", signal);
  expect(mocks.invalidateQueries).not.toHaveBeenCalled();
});

it("refreshes source metadata and the visible cache while the server is still pending", async () => {
  let complete!: (value: boolean) => void;
  mocks.server.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  useServerNovelSync(42, true, "Book");
  const cleanup = mocks.effects[0]!()!;
  const canApplyServerMetadata = mocks.server.mock.calls[0]![2] as () => boolean;
  expect(canApplyServerMetadata()).toBe(true);
  await vi.waitFor(() => expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["novel", 42], exact: true }));
  expect(mocks.source).toHaveBeenCalledOnce();
  expect(canApplyServerMetadata()).toBe(false);
  cleanup();
  complete(false);
});

it("refreshes again on entry but does not refresh an inactive cached page", async () => {
  useServerNovelSync(42, false, "Book");
  expect(mocks.effects[0]!()).toBeUndefined();
  expect(mocks.server).not.toHaveBeenCalled();
  useServerNovelSync(42, true, "Book");
  const cleanup = mocks.effects[1]!()!;
  await vi.waitFor(() => expect(mocks.source).toHaveBeenCalledOnce());
  cleanup();
  useServerNovelSync(42, true, "Book");
  mocks.effects[2]!();
  await vi.waitFor(() => expect(mocks.server).toHaveBeenCalledTimes(2));
});

it("still refreshes the original source when the server fails", async () => {
  const failure = new Error("Server offline");
  mocks.server.mockRejectedValueOnce(failure);
  useServerNovelSync(42, true, "Book");
  mocks.effects[0]!();
  await vi.waitFor(() => expect(mocks.source).toHaveBeenCalledOnce());
  expect(mocks.setState).toHaveBeenCalledWith(failure);
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["novel", 42], exact: true });
});
