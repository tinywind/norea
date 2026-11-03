import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  vpn: undefined as VpnDownloadRuntimeSnapshot | undefined,
  pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), cancelRequest: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(), useEffect: () => undefined, useMemo: (compute: () => unknown) => compute(),
  useState: (initial: unknown) => {
    const index = mocks.index++;
    if (!(index in mocks.states)) mocks.states[index] = typeof initial === "function" ? initial() : initial;
    return [mocks.states[index], (next: unknown) => { mocks.states[index] = typeof next === "function" ? next(mocks.states[index]) : next; }];
  },
  useRef: (initial: unknown) => mocks.refs[mocks.refIndex++] ?? (mocks.refs[mocks.refIndex - 1] = { current: initial }),
}));
vi.mock("../lib/tasks/hooks", async () => {
  const { taskScheduler } = await import("../lib/tasks/scheduler");
  return { useTaskSnapshot: () => taskScheduler.getSnapshot(), useVpnDownloadRuntimeSnapshot: () => mocks.vpn,
    useChapterDownloadRequestSnapshot: () => [{ id: "preparing", title: "Preparing work", phase: "preparing", total: null, novelIds: [42], error: null }] };
});
vi.mock("../components/VpnDownloadPanel", () => ({ VpnDownloadPanel: () => null }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ pauseVpnDownloadRun: mocks.pause, resumeVpnDownloadRun: mocks.resume, cancelVpnDownloadRun: mocks.cancel }));
vi.mock("../lib/tasks/chapter-download", () => ({ cancelChapterDownloadBatches: vi.fn() }));
vi.mock("../lib/tasks/chapter-download-requests", () => ({ cancelChapterDownloadRequest: mocks.cancelRequest }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../components/ui/ConfirmDialog", () => ({ useConfirm: () => confirm }));
import { taskScheduler } from "../lib/tasks/scheduler";
import { TasksPage } from "./tasks";

interface Props { children?: ReactNode; actions?: ReactNode; label?: string; disabled?: boolean; onClick?: () => unknown }
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children), ...elements(element.props.actions)];
}
function render() { mocks.index = 0; mocks.refIndex = 0; return elements(TasksPage()); }
const button = (label: string) => render().find(element => element.props.label === label)!;
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  confirm.mockResolvedValue(true);
  mocks.pause.mockReset().mockResolvedValue(undefined); mocks.resume.mockReset().mockResolvedValue(undefined); mocks.cancel.mockReset().mockResolvedValue(undefined);
  mocks.vpn = { drafts: [], plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 10 }, chapterLabels: {},
    run: { id: "run", status: "running", workerCount: 3, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile", activeWorkers: 0, connectingWorkers: 0, closingWorkers: 0 } };
});

it("cancels a VPN run and preparing requests even before any ordinary chapter row exists", async () => {
  let finish!: () => void;
  mocks.cancel.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const control = button("tasks.cancelAllCurrent");
  expect(control.props.disabled).toBe(false);
  const cancelling = control.props.onClick!();
  await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce());
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    danger: true, message: "tasks.cancelAllConfirm.message tasks.cancelAllConfirm.vpnRun",
  }));
  expect(mocks.cancelRequest).toHaveBeenCalledWith("preparing");
  expect(button("tasks.cancelAllCurrent").props.disabled).toBe(true);
  finish(); await cancelling;
});

it("includes the VPN run in global pause and resume rather than only changing ordinary queues", async () => {
  await button("tasks.pauseAll").props.onClick!();
  expect(mocks.pause).toHaveBeenCalledOnce();
  expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(true);
  mocks.vpn!.run = { ...mocks.vpn!.run!, status: "paused" };
  await button("tasks.resumeAll").props.onClick!();
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(false);
});

it("keeps a failed global cancellation visible and allows an explicit retry", async () => {
  mocks.cancel.mockRejectedValueOnce(new Error("VPN browser cleanup failed"));
  await button("tasks.cancelAllCurrent").props.onClick!();
  expect(render().some(element => element.props.children === "VPN browser cleanup failed")).toBe(true);
  await button("tasks.cancelAllCurrent").props.onClick!();
  expect(mocks.cancel).toHaveBeenCalledTimes(2);
});
