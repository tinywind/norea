import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  vpn: undefined as VpnDownloadRuntimeSnapshot | undefined,
  snapshot: undefined as import("../lib/tasks/task-types").TaskSnapshot | undefined,
  pause: vi.fn(), resume: vi.fn(), resumeQueue: vi.fn(), cancel: vi.fn(), cancelRequest: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(), useEffect: () => undefined, useMemo: (compute: () => unknown) => compute(),
  useState: (initial: unknown) => {
    const index = mocks.index++;
    if (!(index in mocks.states)) mocks.states[index] = typeof initial === "function" ? initial() : initial;
    return [mocks.states[index], (next: unknown) => { mocks.states[index] = typeof next === "function" ? next(mocks.states[index]) : next; }];
  },
  useRef: (initial: unknown) => mocks.refs[mocks.refIndex++] ?? (mocks.refs[mocks.refIndex - 1] = { current: initial }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (value: unknown) => unknown }) => select({ location: { pathname: "/downloads", search: { view: "queue" } } }),
}));
vi.mock("../lib/tasks/hooks", async () => {
  const { taskScheduler } = await import("../lib/tasks/scheduler");
  return { useTaskSnapshot: () => mocks.snapshot ?? taskScheduler.getSnapshot(), useVpnDownloadRuntimeSnapshot: () => mocks.vpn,
    useChapterDownloadRequestSnapshot: () => [{ id: "preparing", title: "Preparing work", phase: "preparing", total: null, novelIds: [42], error: null }],
    useChapterDownloadFailureSnapshot: () => [] };
});
vi.mock("../components/VpnDownloadAttention", () => ({ VpnDownloadAttention: function VpnDownloadAttention() { return null; } }));
vi.mock("../components/VpnDownloadLaunchDialog", () => ({ VpnDownloadLaunchDialog: function VpnDownloadLaunchDialog() { return null; } }));
vi.mock("../components/VpnDownloadWorks", () => ({
  VpnDownloadWorkRow: function VpnDownloadWorkRow() { return null; },
  vpnDownloadWorks: (snapshot: VpnDownloadRuntimeSnapshot) => snapshot.plans.map(plan => ({ key: plan.id, title: plan.title })),
}));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ pauseVpnDownloadRun: mocks.pause, resumeVpnDownloadRun: mocks.resume, cancelVpnDownloadRun: mocks.cancel }));
vi.mock("../lib/tasks/chapter-download", () => ({ cancelChapterDownloadBatches: vi.fn(), resumeChapterDownloadQueueAfterFailure: mocks.resumeQueue }));
vi.mock("../lib/tasks/chapter-download-requests", () => ({ cancelChapterDownloadRequest: mocks.cancelRequest }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../components/ui/ConfirmDialog", () => ({ useConfirm: () => confirm }));
import { taskScheduler } from "../lib/tasks/scheduler";
import { PAGE_SLOT_PROPS } from "../lib/android-back-navigation.test-support";
import { DownloadsQueueView } from "./downloads-queue";

interface Props { work?: { title?: string; group?: { title: string }; sourceTasks?: { id: string }[] }; children?: ReactNode; actions?: ReactNode; label?: string; disabled?: boolean; onClick?: () => unknown; items?: { label: string; onClick: () => void; disabled?: boolean }[] }
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  const slots = element.props as Record<string, unknown>;
  return [element, ...PAGE_SLOT_PROPS.flatMap(slot => elements(slots[slot] as ReactNode)), ...elements(element.props.children)];
}
function render() { mocks.index = 0; mocks.refIndex = 0; return elements(DownloadsQueueView()); }
const pageMenu = () => render().find(element => element.props.label === "common.more" && element.props.items)!.props.items!;
const menuItem = (label: string) => pageMenu().find(item => item.label === label)!;
const pauseButton = (label: string) => render().find(element => element.props.label === label && element.props.onClick)!;
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = []; mocks.snapshot = undefined;
  taskScheduler.resumeSourceQueue();
  mocks.resumeQueue.mockReset().mockImplementation(async (sourceId?: string) => { taskScheduler.resumeSourceQueue(sourceId); return true; });
  confirm.mockResolvedValue(true);
  mocks.pause.mockReset().mockResolvedValue(undefined); mocks.resume.mockReset().mockResolvedValue(undefined); mocks.cancel.mockReset().mockResolvedValue(undefined);
  mocks.vpn = { drafts: [], plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 10 }, chapterLabels: {},
    run: { id: "run", status: "running", workerCount: 3, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile", activeWorkers: 0, connectingWorkers: 0, closingWorkers: 0 } };
});

it("cancels a VPN run and preparing requests even before any ordinary chapter row exists", async () => {
  let finish!: () => void;
  mocks.cancel.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const control = menuItem("tasks.cancelAllCurrent");
  expect(control.disabled).toBe(false);
  control.onClick();
  const cancelling = vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce());
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    danger: true, message: "tasks.cancelAllConfirm.message tasks.cancelAllConfirm.vpnRun",
  }));
  expect(mocks.cancelRequest).toHaveBeenCalledWith("preparing");
  expect(menuItem("tasks.cancelAllCurrent").disabled).toBe(true);
  finish(); await cancelling;
  await vi.waitFor(() => expect(menuItem("tasks.cancelAllCurrent").disabled).toBe(false));
});

it("includes the VPN run in global pause and resume rather than only changing ordinary queues", async () => {
  await pauseButton("downloads.queue.pause").props.onClick!();
  expect(mocks.pause).toHaveBeenCalledOnce();
  expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(true);
  mocks.vpn!.run = { ...mocks.vpn!.run!, status: "paused" };
  await pauseButton("downloads.queue.resume").props.onClick!();
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(false);
});

it("keeps a failed global cancellation visible and allows an explicit retry", async () => {
  mocks.cancel.mockRejectedValueOnce(new Error("VPN browser cleanup failed"));
  menuItem("tasks.cancelAllCurrent").onClick();
  await vi.waitFor(() => expect(render().some(element => element.props.children === "VPN browser cleanup failed")).toBe(true));
  menuItem("tasks.cancelAllCurrent").onClick();
  await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(2));
});

it("lists VPN works as novel rows in the downloads list instead of a separate VPN section", () => {
  mocks.vpn!.plans = [{ id: "plan", title: "VPN novel", ranges: [] } as unknown as VpnDownloadRuntimeSnapshot["plans"][number]];
  const view = render();
  const rows = view.filter(element => typeof element.type === "function" && element.type.name === "VpnDownloadWorkRow");
  expect(rows.map(element => element.props.work?.title)).toEqual(["VPN novel"]);
  expect(view.some(element => element.props.items?.some(item => item.label === "vpnDownload.launchMenu"))).toBe(false);
  mocks.vpn!.run = { ...mocks.vpn!.run!, status: "interrupted" };
  expect(render().some(element => typeof element.type === "function" && element.type.name === "NeedsAttentionSection")).toBe(true);
});

it("keeps the VPN launch dialog behind the page overflow when no VPN run exists", () => {
  mocks.vpn!.run = null;
  const launch = menuItem("vpnDownload.launchMenu");
  expect(render().some(element => typeof element.type === "function" && element.type.name === "VpnDownloadLaunchDialog")).toBe(false);
  launch.onClick();
  expect(render().some(element => typeof element.type === "function" && element.type.name === "VpnDownloadLaunchDialog")).toBe(true);
  mocks.vpn!.capabilities = { supported: false, parallelSupported: false, maxWorkers: 0 };
  expect(pageMenu().some(item => item.label === "vpnDownload.launchMenu")).toBe(false);
});

it("offers source-wide actions over the source's listed tasks, not its hidden VPN worker tasks", () => {
  const base = { lane: "source" as const, kind: "chapter.download" as const, priority: "background" as const, title: "Chapter",
    source: { id: "source", name: "Source" }, status: "queued" as const, createdAt: 1, canCancel: true, canRetry: false };
  mocks.snapshot = { ...taskScheduler.getSnapshot(), sourceQueueOrder: ["source"], records: [
    { ...base, id: "ordinary", subject: { chapterId: 1, novelId: 1, novelName: "Novel" } },
    { ...base, id: "worker", subject: { chapterId: 2, novelId: 2, novelName: "VPN novel" }, vpnWorker: { rangeId: "range", slot: 9 as const, generation: 1 } },
  ] };
  const row = render().find(element => typeof element.type === "function" && element.type.name === "NovelWorkGroup")!;
  expect(row.props.work?.group?.title).toBe("Novel");
  expect(row.props.work?.sourceTasks?.map(task => task.id)).toEqual(["ordinary"]);
});

it("shows retained failure stops in Needs attention even without queued tasks", () => {
  mocks.vpn!.run = null;
  mocks.snapshot = { ...taskScheduler.getSnapshot(), records: [], sourceAccessBlocks: [],
    downloadFailureStops: { sourceErrors: { "source-a": "HTTP 503" } } };
  expect(render().some(element => typeof element.type === "function" && element.type.name === "NeedsAttentionSection")).toBe(true);
});


it("waits for ordinary queue restoration before resuming either queue from the header", async () => {
  taskScheduler.pauseSourceQueue();
  mocks.vpn!.run = { ...mocks.vpn!.run!, status: "paused" };
  let finish!: (restored: boolean) => void;
  mocks.resumeQueue.mockImplementationOnce(async () => {
    const restored = await new Promise<boolean>(resolve => { finish = resolve; });
    if (restored) taskScheduler.resumeSourceQueue();
    return restored;
  });
  const pending = pauseButton("downloads.queue.resume").props.onClick!();
  expect(mocks.resumeQueue).toHaveBeenCalledExactlyOnceWith();
  expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(true);
  expect(mocks.resume).not.toHaveBeenCalled();
  const waiting = pauseButton("downloads.queue.resume");
  expect(waiting.props.disabled).toBe(true);
  await waiting.props.onClick!();
  expect(mocks.resumeQueue).toHaveBeenCalledOnce();
  finish(true);
  await pending;
  expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(false);
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it("keeps both queues paused when restoration fails and permits a later explicit resume", async () => {
  taskScheduler.pauseSourceQueue();
  mocks.vpn!.run = { ...mocks.vpn!.run!, status: "paused" };
  mocks.resumeQueue.mockResolvedValueOnce(false);
  await pauseButton("downloads.queue.resume").props.onClick!();
  expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(true);
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(pauseButton("downloads.queue.resume").props.disabled).toBe(false);
  await pauseButton("downloads.queue.resume").props.onClick!();
  expect(mocks.resumeQueue).toHaveBeenCalledTimes(2);
  expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(false);
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it("restores a source queue through the recovery service and serializes its row action", async () => {
  mocks.vpn!.run = null;
  mocks.snapshot = { ...taskScheduler.getSnapshot(), pausedSourceIds: ["source"], sourceQueueOrder: ["source"], records: [{
    id: "ordinary", lane: "source", kind: "chapter.download", priority: "background", title: "Chapter",
    source: { id: "source", name: "Source" }, status: "queued", createdAt: 1, canCancel: true, canRetry: false,
    subject: { chapterId: 1, novelId: 1, novelName: "Novel" },
  }] };
  const sourceResume = () => {
    const row = render().find(element => typeof element.type === "function" && element.type.name === "NovelWorkGroup")!;
    return elements((row.type as (props: Props) => ReactNode)(row.props))
      .flatMap(element => element.props.items ?? []).find(item => item.label === "downloads.queue.resumeSource")!;
  };
  let finish!: (restored: boolean) => void;
  mocks.resumeQueue.mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve; }));
  const pending = sourceResume().onClick();
  expect(mocks.resumeQueue).toHaveBeenCalledExactlyOnceWith("source");
  expect(sourceResume().disabled).toBe(true);
  await sourceResume().onClick();
  expect(mocks.resumeQueue).toHaveBeenCalledOnce();
  expect(mocks.resume).not.toHaveBeenCalled();
  finish(false);
  await pending;
  expect(sourceResume().disabled).toBe(false);
  expect(mocks.snapshot.pausedSourceIds).toEqual(["source"]);
});
