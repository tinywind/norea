import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { VpnDownloadPlan } from "../lib/tasks/vpn-download-types";

const mocks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.index++;
    if (!(index in mocks.states)) mocks.states[index] = typeof initial === "function" ? initial() : initial;
    return [mocks.states[index], (next: unknown) => { mocks.states[index] = typeof next === "function" ? next(mocks.states[index]) : next; }];
  },
  useRef: (initial: unknown) => mocks.refs[mocks.refIndex++] ?? (mocks.refs[mocks.refIndex - 1] = { current: initial }),
}));
vi.mock("../store/vpn-download", () => ({ useVpnDownloadStore: (select: (value: unknown) => unknown) => select({ mode: "parallel", workerCount: 2 }) }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}` }) }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("./ui/ConfirmDialog", () => ({ useConfirm: () => confirm }));
import { VpnDownloadRanges } from "./VpnDownloadRanges";

interface Props { children?: ReactNode; label?: string; disabled?: boolean; onClick?: () => unknown; "data-vpn-range"?: string; "data-vpn-work"?: string }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
const actions = { retryDraft: vi.fn(), pauseWork: vi.fn(), resumeWork: vi.fn(), cancelDraft: vi.fn(), cancelHandoverWork: vi.fn(), resumeRange: vi.fn(), pauseRange: vi.fn(), cancelRange: vi.fn(), openVerification: vi.fn() };
const profiles = ["a", "b"].map((id, index) => ({ id, ip: `192.0.2.${index + 1}`, protocol: "udp" as const, hash: "a".repeat(64), approvedAt: 1, approvalSequence: index }));
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
      { id: "lane-a", profileId: "a", profileHash: "a".repeat(64), startChapterId: 90, endChapterId: 35, chapterIds: [90, 7, 35], selectedChapterIds: [90, 35], checkpoint: 1,
        phase: "paused", userPaused: false, pauseReason: "profiles-exhausted", attemptedProfileIds: ["a", "c"], attemptProfileId: null, generation: 2, challenge: { kind: "captcha", url: "https://source.test" } },
      { id: "lane-b", profileId: "b", profileHash: "b".repeat(64), startChapterId: 1, endChapterId: 4, chapterIds: [1, 70, 4], selectedChapterIds: [1, 4], checkpoint: 0,
        phase: "running", userPaused: false, pauseReason: null, attemptedProfileIds: [], attemptProfileId: null, generation: 3, challenge: null },
    ] };
}
function render(value = snapshot()) {
  mocks.index = 0; mocks.refIndex = 0;
  return controls(VpnDownloadRanges({ snapshot: value, profiles, actions }));
}
function childText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Array.isArray(node) ? node.map(childText).join(" ") : "";
}
const text = (view: ReactElement<Props>[]) => view.map(element => childText(element.props.children)).join(" ");
const button = (view: ReactElement<Props>[], key: string) => view.find(element => element.props.children === key)!;
const row = (view: ReactElement<Props>[], id: string) => controls(view.find(element => element.props["data-vpn-range"] === id));
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  confirm.mockResolvedValue(true);
  for (const action of Object.values(actions)) action.mockResolvedValue(undefined);
});

it("shows preparation before a catalog exists and offers only cancellation, not assignments or another Start", async () => {
  const view = render();
  expect(text(view)).toContain("Work");
  expect(text(view)).toContain("vpnDownload.phase.preparing");
  expect(button(view, "vpnDownload.start")).toBeUndefined();
  expect(view.some(element => ["vpnDownload.startPosition", "vpnDownload.endPosition", "vpnDownload.profile"].includes(element.props.label ?? ""))).toBe(false);
  await button(view, "vpnDownload.cancelDraft").props.onClick!();
  expect(actions.cancelDraft).toHaveBeenCalledWith("draft");
});

it("shows the chapter-boundary handover wait under its work rather than duplicating an ordinary chapter row", async () => {
  const value = snapshot(); value.drafts = [];
  value.handover = [{ id: "handover-work", pluginId: "source", novelId: 42, title: "Work", chapterIds: [90] }];
  const view = render(value);
  expect(text(view)).toContain("vpnDownload.phase.waitingHandover");
  await button(view, "vpnDownload.cancelDraft").props.onClick!();
  expect(actions.cancelHandoverWork).toHaveBeenCalledWith("handover-work");
});

it.each(["waiting-profile", "failed"] as const)("keeps %s preparation visible with its own reason", phase => {
  const value = snapshot();
  value.drafts = [{ ...value.drafts[0]!, phase, error: phase === "failed" ? "Catalog unavailable" : null }];
  const view = render(value);
  expect(text(view)).toContain(phase === "failed" ? "Catalog unavailable" : "vpnDownload.phase.waitingProfile");
});

it("offers a direct retry for failed preparation without requiring another Start or resuming a paused run", async () => {
  const value = snapshot(); value.drafts[0]!.phase = "failed"; value.drafts[0]!.error = "Catalog unavailable";
  await button(render(value), "common.retry").props.onClick!();
  expect(actions.retryDraft).toHaveBeenCalledExactlyOnceWith("draft");
  value.run = { ...value.run!, status: "paused" };
  const retry = button(render(value), "common.retry");
  expect(retry.props.disabled).toBe(true);
  await retry.props.onClick!();
  expect(actions.retryDraft).toHaveBeenCalledOnce();
});

it("groups multiple plans for one work and shows total progress without marking a healthy sibling failed", () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan(), { ...activePlan(), id: "plan-two", ranges: [] }];
  value.chapterLabels = { plan: { 90: "Opening", 35: "Extra 1.5", 1: "Next", 4: "Ending" } };
  const view = render(value);
  expect(view.filter(element => element.props["data-vpn-work"])).toHaveLength(1);
  expect(text(view)).toContain('vpnDownload.progress{"completed":1,"total":4}');
  expect(text(row(view, "lane-a"))).toContain("vpnDownload.reason.exhausted");
  expect(text(row(view, "lane-b"))).toContain("vpnDownload.phase.running");
  expect(text(row(view, "lane-b"))).not.toContain("vpnDownload.reason.exhausted");
  expect(text(view)).toContain("Extra 1.5");
});

it("does not reset the profile pass on ordinary Resume and cannot bypass a paused run", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  value.plans[0]!.ranges[0]!.pauseReason = "interrupted";
  await button(row(render(value), "lane-a"), "vpnDownload.resume").props.onClick!();
  expect(actions.resumeRange).toHaveBeenCalledWith("plan", "lane-a");
  value.run = { ...value.run!, status: "paused" };
  const control = button(row(render(value), "lane-a"), "vpnDownload.resume");
  expect(control.props.disabled).toBe(true);
  await control.props.onClick!();
  expect(actions.resumeRange).toHaveBeenCalledTimes(1);
});

it("routes independent range controls by both identities and separates explicit pass restart from Resume", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  const view = render(value);
  const first = row(view, "lane-a"), second = row(view, "lane-b");
  await button(first, "vpnDownload.restartPass").props.onClick!();
  expect(actions.resumeRange).toHaveBeenCalledWith("plan", "lane-a", true);
  expect(button(first, "vpnDownload.resume").props.disabled).toBe(true);
  await button(first, "vpnDownload.openVerification").props.onClick!();
  await button(first, "vpnDownload.cancelRange").props.onClick!();
  await button(second, "vpnDownload.pause").props.onClick!();
  expect(actions.openVerification).toHaveBeenCalledWith("plan", "lane-a");
  expect(actions.cancelRange).toHaveBeenCalledWith("plan", "lane-a");
  expect(actions.pauseRange).toHaveBeenCalledWith("plan", "lane-b");
});

it("keeps action failure and pending controls local to their own range", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  let finish!: () => void;
  actions.openVerification.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const verifying = button(row(render(value), "lane-a"), "vpnDownload.openVerification").props.onClick!();
  expect(button(row(render(value), "lane-a"), "vpnDownload.cancelRange").props.disabled).toBe(true);
  expect(button(row(render(value), "lane-b"), "vpnDownload.pause").props.disabled).toBe(false);
  finish(); await verifying;
  actions.openVerification.mockRejectedValueOnce(new Error("Worker verification failed"));
  await button(row(render(value), "lane-a"), "vpnDownload.openVerification").props.onClick!();
  expect(text(row(render(value), "lane-a"))).toContain("Worker verification failed");
  expect(text(row(render(value), "lane-b"))).not.toContain("Worker verification failed");
});

it("cancels all pending and enrolled parts of one work without targeting another work", async () => {
  const value = snapshot();
  value.plans = [activePlan(), { ...activePlan(), id: "other", novelId: 99, title: "Other work", ranges: [{ ...activePlan().ranges[1]!, id: "other-range" }] }];
  const group = controls(render(value).find(element => element.props["data-vpn-work"] === '["source",42]'));
  await button(group, "vpnDownload.cancelWork").props.onClick!();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    danger: true, message: 'vpnDownload.cancelWorkConfirm.message{"count":3}',
  }));
  expect(actions.cancelDraft).toHaveBeenCalledExactlyOnceWith("draft");
  expect(actions.cancelRange.mock.calls).toEqual([["plan", "lane-a"], ["plan", "lane-b"]]);
});

it("keeps work and ranges running when their cancellation is not confirmed", async () => {
  const value = snapshot(); value.plans = [activePlan()];
  confirm.mockResolvedValue(false);
  const view = render(value);
  await button(view, "vpnDownload.cancelWork").props.onClick!();
  await button(row(view, "lane-b"), "vpnDownload.cancelRange").props.onClick!();
  expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({
    danger: true, message: expect.stringContaining('"completed":0,"total":2'),
  }));
  expect(actions.cancelDraft).not.toHaveBeenCalled();
  expect(actions.cancelRange).not.toHaveBeenCalled();
});

it("routes work pause and resume through the whole-work boundary rather than individual range snapshots", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  await button(render(value), "vpnDownload.pauseWork").props.onClick!();
  expect(actions.pauseWork).toHaveBeenCalledExactlyOnceWith("source", 42);
  expect(actions.pauseRange).not.toHaveBeenCalled();
  value.plans[0]!.ranges[1]!.phase = "paused";
  value.plans[0]!.ranges[1]!.userPaused = true;
  value.plans[0]!.ranges[1]!.pauseReason = "work-paused";
  await button(render(value), "vpnDownload.resumeWork").props.onClick!();
  expect(actions.resumeWork).toHaveBeenCalledExactlyOnceWith("source", 42);
  expect(actions.resumeRange).not.toHaveBeenCalled();
});

it("offers Pause work for automatic waiters and holds range Resume behind a paused work", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  value.plans[0]!.ranges = [{ ...value.plans[0]!.ranges[1]!, phase: "paused", pauseReason: "profile-in-use" }];
  expect(button(render(value), "vpnDownload.pauseWork").props.disabled).toBe(false);
  value.plans[0]!.ranges[0]!.userPaused = true;
  value.plans[0]!.ranges[0]!.pauseReason = "work-paused";
  expect(button(row(render(value), "lane-b"), "vpnDownload.resume").props.disabled).toBe(true);
  expect(button(render(value), "vpnDownload.resumeWork").props.disabled).toBe(false);
});

it("keeps markup bounded for a large catalog instead of rendering chapter or profile editors", () => {
  const value = snapshot();
  value.drafts = [{ ...value.drafts[0]!, chapters: Array.from({ length: 20_000 }, (_, index) => ({ id: index + 1, name: `Chapter ${index + 1}`, chapterNumber: String(index + 1) })) }];
  const view = render(value);
  expect(view.length).toBeLessThan(60);
  expect(view.some(element => element.props.label)).toBe(false);
});
