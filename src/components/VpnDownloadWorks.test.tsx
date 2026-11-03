import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { VpnDownloadPlan } from "../lib/tasks/vpn-download-types";
import type { OverflowMenuItem } from "./ui/OverflowMenu";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  profiles: [] as { id: string; ip: string; protocol: "udp" | "tcp"; hash: string; approvedAt: number; approvalSequence: number }[],
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.index++;
    if (!(index in mocks.states)) mocks.states[index] = typeof initial === "function" ? initial() : initial;
    return [mocks.states[index], (next: unknown) => { mocks.states[index] = typeof next === "function" ? next(mocks.states[index]) : next; }];
  },
  useRef: (initial: unknown) => mocks.refs[mocks.refIndex++] ?? (mocks.refs[mocks.refIndex - 1] = { current: initial }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { limit: 20, cleanupError: null, profiles: mocks.profiles }, isPending: false, isError: false }) }));
vi.mock("../lib/plugin-vpn-profiles", () => ({ SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "saved-profiles"], listSavedPluginVpnProfiles: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({
  cancelVpnDownloadDraft: vi.fn(), cancelVpnDownloadHandoverWork: vi.fn(), cancelVpnDownloadRange: vi.fn(), openVpnDownloadVerification: vi.fn(),
  pauseVpnDownloadWork: vi.fn(), resumeVpnDownloadRange: vi.fn(), resumeVpnDownloadWork: vi.fn(), startVpnDownloadDraft: vi.fn(),
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}` }) }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("./ui/ConfirmDialog", () => ({ useConfirm: () => confirm }));
import { OverflowMenu } from "./ui/OverflowMenu";
import { VpnDownloadWorkDetails, VpnDownloadWorkRow, vpnDownloadWorks } from "./VpnDownloadWorks";

interface Props { children?: ReactNode; label?: string; disabled?: boolean; onClick?: () => unknown; items?: OverflowMenuItem[]; "data-vpn-range"?: string }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
const actions = { retryDraft: vi.fn(), pauseWork: vi.fn(), resumeWork: vi.fn(), cancelDraft: vi.fn(), cancelHandoverWork: vi.fn(), resumeRange: vi.fn(), cancelRange: vi.fn(), openVerification: vi.fn() };
function snapshot(): VpnDownloadRuntimeSnapshot {
  return {
    drafts: [{ id: "draft", batchId: "batch", title: "Work", pluginId: "source", novelId: 42, chapters: [], selectedChapterIds: [90, 35, 1, 4], error: null, phase: "preparing" }],
    plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 10 }, chapterLabels: {},
    run: { id: "run", status: "running", workerCount: 3, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile", activeWorkers: 0, connectingWorkers: 0, closingWorkers: 0 },
  };
}
function activePlan(): VpnDownloadPlan {
  return { id: "plan", batchId: "batch", pluginId: "source", novelId: 42, title: "Work", mode: "parallel", policies: { captcha: "pause", cloudflare: "nextProfile" }, createdAt: 1, revision: 0,
    ranges: [
      { id: "lane-a", profileId: "a", profileHash: "hash-a", startChapterId: 90, endChapterId: 35, chapterIds: [90, 7, 35], selectedChapterIds: [90, 35], checkpoint: 1,
        phase: "paused", userPaused: false, pauseReason: "challenge-captcha", attemptedProfileIds: ["a"], attemptProfileId: null, generation: 2, challenge: { kind: "captcha", url: "https://source.test" } },
      { id: "lane-b", profileId: "b", profileHash: "hash-b", startChapterId: 1, endChapterId: 4, chapterIds: [1, 70, 4], selectedChapterIds: [1, 4], checkpoint: 0,
        phase: "running", userPaused: false, pauseReason: null, attemptedProfileIds: [], attemptProfileId: null, generation: 3, challenge: null },
    ] };
}
function withPlans(...plans: VpnDownloadPlan[]): VpnDownloadRuntimeSnapshot {
  const value = snapshot(); value.drafts = []; value.plans = plans; return value;
}
function renderRow(value = snapshot()) {
  mocks.index = 0; mocks.refIndex = 0;
  return controls(VpnDownloadWorkRow({ work: vpnDownloadWorks(value)[0]!, snapshot: value, actions }));
}
function renderDetails(value = snapshot()) {
  mocks.index = 0; mocks.refIndex = 0;
  return controls(VpnDownloadWorkDetails({ work: vpnDownloadWorks(value)[0]!, snapshot: value, actions }));
}
function childText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Array.isArray(node) ? node.map(childText).join(" ") : "";
}
const text = (view: ReactElement<Props>[]) => view.map(element => childText(element.props.children)).join(" ");
const button = (view: ReactElement<Props>[], key: string) => view.find(element => element.props.children === key)!;
const menu = (view: ReactElement<Props>[]) => view.find(element => element.type === OverflowMenu)!.props.items!;
const item = (view: ReactElement<Props>[], key: string) => menu(view).find(entry => entry.label === key);
const row = (view: ReactElement<Props>[], id: string) => controls(view.find(element => element.props["data-vpn-range"] === id));
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  mocks.profiles = [{ id: "a", ip: "192.0.2.1", protocol: "udp", hash: "hash-a", approvedAt: 1, approvalSequence: 1 }];
  confirm.mockResolvedValue(true);
  for (const action of Object.values(actions)) action.mockResolvedValue(undefined);
});

it("gathers one novel's drafts, waits and plans into one row and leaves finished work out", () => {
  const value = withPlans(activePlan(), { ...activePlan(), id: "plan-two", ranges: [] });
  value.handover = [{ id: "handover-work", pluginId: "source", novelId: 42, title: "Work", chapterIds: [5, 6] }];
  const finished = { ...activePlan(), id: "done", novelId: 7, title: "Done", ranges: [{ ...activePlan().ranges[1]!, id: "done-range", phase: "completed" as const, checkpoint: 2 }] };
  value.plans = [...value.plans, finished];
  const works = vpnDownloadWorks(value);
  expect(works.map(work => work.title)).toEqual(["Work"]);
  expect(works[0]).toMatchObject({ completed: 1, total: 6, held: false, canPause: true });
});

it("shows a plain novel row with progress and a VPN label but no range rows or range buttons", () => {
  const view = renderRow(withPlans(activePlan()));
  expect(text(view)).toContain("Work");
  expect(text(view)).toContain("vpnDownload.routeLabel");
  expect(text(view)).toContain('vpnDownload.workProgress{"completed":1,"total":4}');
  expect(view.some(element => element.props["data-vpn-range"])).toBe(false);
  expect(text(view)).not.toContain("vpnDownload.reason");
  expect(menu(view).map(entry => entry.label)).toEqual(["vpnDownload.pauseWork", "vpnDownload.details", "vpnDownload.cancelWork"]);
});

it("opens the technical breakdown only from the row's Details action", () => {
  expect(renderRow(withPlans(activePlan())).some(element => element.type === VpnDownloadWorkDetails)).toBe(false);
  item(renderRow(withPlans(activePlan())), "vpnDownload.details")!.onClick();
  expect(renderRow(withPlans(activePlan())).some(element => element.type === VpnDownloadWorkDetails)).toBe(true);
});

it("routes work pause and resume through the whole-work boundary and holds them while the run is paused", async () => {
  const value = withPlans(activePlan());
  item(renderRow(value), "vpnDownload.pauseWork")!.onClick();
  await vi.waitFor(() => expect(actions.pauseWork).toHaveBeenCalledExactlyOnceWith("source", 42));
  value.plans[0]!.ranges[1]!.phase = "paused";
  value.plans[0]!.ranges[1]!.userPaused = true;
  value.plans[0]!.ranges[1]!.pauseReason = "work-paused";
  expect(text(renderRow(value))).toContain("vpnDownload.phase.paused");
  item(renderRow(value), "vpnDownload.resumeWork")!.onClick();
  await vi.waitFor(() => expect(actions.resumeWork).toHaveBeenCalledExactlyOnceWith("source", 42));
  value.run = { ...value.run!, status: "paused" };
  expect(item(renderRow(value), "vpnDownload.resumeWork")!.disabled).toBe(true);
  expect(actions.resumeRange).not.toHaveBeenCalled();
});

it("cancels all pending and enrolled parts of one work only after confirmation", async () => {
  const value = snapshot();
  value.plans = [activePlan(), { ...activePlan(), id: "other", novelId: 99, title: "Other work", ranges: [{ ...activePlan().ranges[1]!, id: "other-range" }] }];
  confirm.mockResolvedValueOnce(false);
  item(renderRow(value), "vpnDownload.cancelWork")!.onClick();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(actions.cancelRange).not.toHaveBeenCalled();
  item(renderRow(value), "vpnDownload.cancelWork")!.onClick();
  await vi.waitFor(() => expect(actions.cancelRange).toHaveBeenCalledTimes(2));
  expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true, message: 'vpnDownload.cancelWorkConfirm.message{"count":3}' }));
  expect(actions.cancelDraft).toHaveBeenCalledExactlyOnceWith("draft");
  expect(actions.cancelRange.mock.calls).toEqual([["plan", "lane-a"], ["plan", "lane-b"]]);
});

it("shows each range's interval, state and server in Details without a profile id or hash", () => {
  const value = withPlans(activePlan());
  value.chapterLabels = { plan: { 90: "Opening", 35: "Extra 1.5", 1: "Next", 4: "Ending" } };
  const view = renderDetails(value);
  expect(text(row(view, "lane-a"))).toContain("Opening / Extra 1.5");
  expect(text(row(view, "lane-a"))).toContain("vpnDownload.reason.captcha");
  expect(text(row(view, "lane-a"))).toContain('vpnDownload.server{"ip":"192.0.2.1","protocol":"UDP"}');
  expect(text(row(view, "lane-b"))).toContain("vpnDownload.phase.running");
  expect(text(row(view, "lane-b"))).toContain("vpnDownload.serverPending");
  expect(text(view)).not.toContain("hash-");
});

it("offers range actions only for a manual verification or a range the user paused", async () => {
  const value = withPlans(activePlan());
  value.plans[0]!.ranges.push(
    { ...activePlan().ranges[1]!, id: "lane-c", phase: "paused", pauseReason: "profiles-exhausted" },
    { ...activePlan().ranges[1]!, id: "lane-d", phase: "paused", pauseReason: "interrupted" },
    { ...activePlan().ranges[1]!, id: "lane-e", phase: "paused", pauseReason: "user-paused", userPaused: true },
  );
  const view = renderDetails(value);
  expect(row(view, "lane-a").filter(element => element.props.onClick).map(element => element.props.children)).toEqual(["vpnDownload.openVerification"]);
  for (const id of ["lane-b", "lane-c", "lane-d"]) expect(row(view, id).some(element => element.props.onClick)).toBe(false);
  await button(row(view, "lane-a"), "vpnDownload.openVerification").props.onClick!();
  await button(row(renderDetails(value), "lane-e"), "vpnDownload.resume").props.onClick!();
  expect(actions.openVerification).toHaveBeenCalledWith("plan", "lane-a");
  expect(actions.resumeRange).toHaveBeenCalledWith("plan", "lane-e");
});

it("keeps a range action failure local to its range", async () => {
  const value = withPlans(activePlan());
  actions.openVerification.mockRejectedValueOnce(new Error("Worker verification failed"));
  await button(row(renderDetails(value), "lane-a"), "vpnDownload.openVerification").props.onClick!();
  expect(text(row(renderDetails(value), "lane-a"))).toContain("Worker verification failed");
  expect(text(row(renderDetails(value), "lane-b"))).not.toContain("Worker verification failed");
});

it("offers a direct retry for failed preparation in Details but not while the run is paused", async () => {
  const value = snapshot(); value.drafts[0]!.phase = "failed"; value.drafts[0]!.error = "Catalog unavailable";
  expect(text(renderDetails(value))).toContain("Catalog unavailable");
  await button(renderDetails(value), "common.retry").props.onClick!();
  expect(actions.retryDraft).toHaveBeenCalledExactlyOnceWith("draft");
  value.run = { ...value.run!, status: "paused" };
  const retry = button(renderDetails(value), "common.retry");
  expect(retry.props.disabled).toBe(true);
  await retry.props.onClick!();
  expect(actions.retryDraft).toHaveBeenCalledOnce();
});

it("keeps markup bounded for a large catalog instead of rendering chapter or profile editors", () => {
  const value = snapshot();
  value.drafts = [{ ...value.drafts[0]!, chapters: Array.from({ length: 20_000 }, (_, index) => ({ id: index + 1, name: `Chapter ${index + 1}`, chapterNumber: String(index + 1) })) }];
  expect(renderRow(value).length).toBeLessThan(30);
  expect(renderDetails(value).length).toBeLessThan(30);
});
