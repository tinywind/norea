import { beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ task: vi.fn(), vpn: vi.fn(), request: vi.fn(), callbacks: [] as (() => void)[] }));
vi.mock("react", () => ({ useSyncExternalStore: (subscribe: (callback: () => void) => () => void, getSnapshot: () => unknown) => {
  boundary.callbacks.push(subscribe(() => undefined));
  return getSnapshot();
} }));
vi.mock("./scheduler", () => ({ taskScheduler: { subscribe: boundary.task, getSnapshot: () => ({ records: [] }) } }));
vi.mock("./vpn-download-runtime", () => ({ subscribeVpnDownloadRuntime: boundary.vpn, getVpnDownloadRuntimeSnapshot: () => ({ plans: [], drafts: [] }) }));
vi.mock("./chapter-download-requests", () => ({ subscribeChapterDownloadRequests: boundary.request, getChapterDownloadRequestSnapshot: () => [] }));
import { useTaskSnapshot, useVpnDownloadRuntimeSnapshot, useChapterDownloadRequestSnapshot } from "./hooks";

beforeEach(() => {
  for (const unsubscribe of boundary.callbacks) unsubscribe();
  boundary.callbacks = []; vi.clearAllMocks();
  boundary.task.mockReturnValue(() => undefined); boundary.vpn.mockReturnValue(() => undefined); boundary.request.mockReturnValue(() => undefined);
});

it("does not attach task, VPN or request listeners while the Tasks page is hidden", () => {
  useTaskSnapshot(false); useVpnDownloadRuntimeSnapshot(false); useChapterDownloadRequestSnapshot(false);
  expect(boundary.task).not.toHaveBeenCalled(); expect(boundary.vpn).not.toHaveBeenCalled(); expect(boundary.request).not.toHaveBeenCalled();
});

it("attaches all three canonical state sources when the Tasks page is active", () => {
  useTaskSnapshot(); useVpnDownloadRuntimeSnapshot(); useChapterDownloadRequestSnapshot();
  expect(boundary.task).toHaveBeenCalledOnce(); expect(boundary.vpn).toHaveBeenCalledOnce(); expect(boundary.request).toHaveBeenCalledOnce();
});
