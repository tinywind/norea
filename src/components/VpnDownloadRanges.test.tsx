import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { VpnDownloadPlan } from "../lib/tasks/vpn-download-types";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  settings: { mode: "parallel", workerCount: 2 },
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
vi.mock("../store/vpn-download", () => ({ useVpnDownloadStore: (select: (value: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}` }) }));
import { VpnDownloadRanges } from "./VpnDownloadRanges";

interface Props { children?: ReactNode; label?: string; disabled?: boolean; value?: unknown; data?: { value: string; disabled?: boolean }[]; onChange?: (value: string | number) => unknown; onClick?: () => unknown; "data-vpn-range"?: string }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
const actions = {
  startDraft: vi.fn(), cancelDraft: vi.fn(), resumeRange: vi.fn(), pauseRange: vi.fn(), cancelRange: vi.fn(), openVerification: vi.fn(),
};
const profiles = ["a", "b", "c"].map((id, index) => ({
  profile: { id, ip: `192.0.2.${index + 1}`, protocol: "udp" as const, hash: "a".repeat(64), approvedAt: 1, approvalSequence: index },
  unavailableReason: id === "c" ? "Already leased" : null,
}));
function snapshot(): VpnDownloadRuntimeSnapshot {
  return {
    drafts: [{ id: "draft", batchId: "batch", title: "Work", pluginId: "source", novelId: 42,
      chapters: [90, 7, 35, 1, 70, 4].map((id, index) => ({ id, name: `Chapter ${id}`, chapterNumber: index === 1 ? "1.5" : String(index + 1) })),
      selectedChapterIds: [90, 35, 1, 4], error: null }],
    plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 2 }, chapterLabels: {},
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
function render(value = snapshot(), options = profiles, ready = true) {
  mocks.index = 0; mocks.refIndex = 0;
  return controls(VpnDownloadRanges({ snapshot: value, profiles: options, profilesReady: ready, actions }));
}
function childText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Array.isArray(node) ? node.map(childText).join(" ") : "";
}
const text = (view: ReactElement<Props>[]) => view.map(element => childText(element.props.children)).join(" ");
const start = (view: ReactElement<Props>[]) => view.find(element => element.props.children === "vpnDownload.start")!;
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = []; mocks.settings = { mode: "parallel", workerCount: 2 };
  for (const action of Object.values(actions)) action.mockResolvedValue(undefined);
});

it("starts the exact proposed canonical intervals instead of treating display numbers as chapter indexes", async () => {
  const view = render();
  expect(view.filter(element => element.props.label === "vpnDownload.startPosition").map(element => element.props.value)).toEqual([1, 4]);
  expect(text(view)).toContain("Chapter 90");
  expect(text(view)).toContain("Chapter 35");
  await start(view).props.onClick!();
  expect(actions.startDraft).toHaveBeenCalledWith("draft", [
    { profileId: "a", startChapterId: 90, endChapterId: 35 },
    { profileId: "b", startChapterId: 1, endChapterId: 4 },
  ]);
});

it.each([
  ["overlap", "start", 1, 3],
  ["unassigned", "start", 1, 5],
  ["reversed", "start", 0, 4],
] as const)("disables Start for an invalid %s draft and prevents dispatch", async (_kind, boundary, index, position) => {
  const view = render();
  const key = boundary === "start" ? "vpnDownload.startPosition" : "vpnDownload.endPosition";
  view.filter(element => element.props.label === key)[index]!.props.onChange!(position);
  const invalid = render();
  expect(start(invalid).props.disabled).toBe(true);
  await start(invalid).props.onClick!();
  expect(actions.startDraft).not.toHaveBeenCalled();
  expect(invalid.some(element => element.props.children && String(element.props.children).startsWith("vpnDownload.invalid"))).toBe(true);
});

it("keeps unavailable retained profiles disabled and rejects a synthetic unavailable selection", async () => {
  const selectors = render().filter(element => element.props.label === "vpnDownload.profile");
  expect(selectors[0]!.props.data?.find(option => option.value === "c")?.disabled).toBe(true);
  selectors[0]!.props.onChange!("c");
  const invalid = render();
  expect(start(invalid).props.disabled).toBe(true);
  await start(invalid).props.onClick!();
  expect(actions.startDraft).not.toHaveBeenCalled();
});

it("requires an enabled supported mode and a loaded profile pool before starting", () => {
  expect(start(render(snapshot(), profiles, false)).props.disabled).toBe(true);
  mocks.settings.mode = "off";
  expect(start(render()).props.disabled).toBe(true);
  mocks.settings.mode = "parallel";
  const value = snapshot(); value.capabilities.parallelSupported = false;
  expect(start(render(value)).props.disabled).toBe(true);
  mocks.settings.mode = "single";
  value.capabilities = { supported: true, parallelSupported: false, maxWorkers: 0 };
  expect(start(render(value)).props.disabled).toBe(true);
});

it("does not reset the profile pass on ordinary resume and refuses resume while automatic mode is Off", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  value.plans[0]!.ranges[0]!.pauseReason = "interrupted";
  let row = controls(render(value).find(element => element.props["data-vpn-range"] === "lane-a"));
  await row.find(element => element.props.children === "vpnDownload.resume")!.props.onClick!();
  expect(actions.resumeRange).toHaveBeenCalledWith("plan", "lane-a");
  mocks.settings.mode = "off";
  row = controls(render(value).find(element => element.props["data-vpn-range"] === "lane-a"));
  expect(row.find(element => element.props.children === "vpnDownload.resume")!.props.disabled).toBe(true);
  await row.find(element => element.props.children === "vpnDownload.resume")!.props.onClick!();
  expect(actions.resumeRange).toHaveBeenCalledTimes(1);
});

it("keeps a failed range action visible on its own row without changing a sibling's challenge", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  actions.openVerification.mockRejectedValue(new Error("Worker verification failed"));
  let rows = render(value);
  await controls(rows.find(element => element.props["data-vpn-range"] === "lane-a"))
    .find(element => element.props.children === "vpnDownload.openVerification")!.props.onClick!();
  rows = render(value);
  expect(text(controls(rows.find(element => element.props["data-vpn-range"] === "lane-a")))).toContain("Worker verification failed");
  expect(text(controls(rows.find(element => element.props["data-vpn-range"] === "lane-b")))).not.toContain("Worker verification failed");
  expect(value.plans[0]!.ranges[0]!.challenge?.kind).toBe("captcha");
});

it("renders only two interval rows for a large chapter catalog", () => {
  const value = snapshot();
  const chapters = Array.from({ length: 20_000 }, (_, index) => ({ id: index + 1, name: `Chapter ${index + 1}`, chapterNumber: String(index + 1) }));
  value.drafts = [{ ...value.drafts[0]!, chapters, selectedChapterIds: [1, 10_000, 20_000] }];
  const view = render(value);
  expect(view.filter(element => element.props.label === "vpnDownload.startPosition")).toHaveLength(2);
  expect(view.length).toBeLessThan(100);
  expect(view.filter(element => element.props.data).every(element => element.props.data!.length === 3)).toBe(true);
});

it("routes independent range actions by both identities and separates explicit pass restart from Resume", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  value.chapterLabels = { plan: { 90: "Opening", 35: "Extra 1.5", 1: "Next", 4: "Ending" } };
  const view = render(value);
  const first = controls(view.find(element => element.props["data-vpn-range"] === "lane-a"));
  const second = controls(view.find(element => element.props["data-vpn-range"] === "lane-b"));
  expect(text(view)).toContain("Extra 1.5");
  await first.find(element => element.props.children === "vpnDownload.restartPass")!.props.onClick!();
  expect(actions.resumeRange).toHaveBeenCalledWith("plan", "lane-a", true);
  expect(first.find(element => element.props.children === "vpnDownload.resume")!.props.disabled).toBe(true);
  await first.find(element => element.props.children === "vpnDownload.openVerification")!.props.onClick!();
  await first.find(element => element.props.children === "vpnDownload.cancelRange")!.props.onClick!();
  await second.find(element => element.props.children === "vpnDownload.pause")!.props.onClick!();
  expect(actions.openVerification).toHaveBeenCalledWith("plan", "lane-a");
  expect(actions.cancelRange).toHaveBeenCalledWith("plan", "lane-a");
  expect(actions.pauseRange).toHaveBeenCalledWith("plan", "lane-b");
});

it("retains the sibling challenge when another range resolves and isolates pending controls", async () => {
  const value = snapshot(); value.drafts = []; value.plans = [activePlan()];
  let finish!: () => void;
  actions.openVerification.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = render(value).find(element => element.props["data-vpn-range"] === "lane-a")!;
  const promise = controls(first).find(element => element.props.children === "vpnDownload.openVerification")!.props.onClick!();
  const busy = render(value);
  expect(controls(busy.find(element => element.props["data-vpn-range"] === "lane-a")).find(element => element.props.children === "vpnDownload.cancelRange")!.props.disabled).toBe(true);
  expect(controls(busy.find(element => element.props["data-vpn-range"] === "lane-b")).find(element => element.props.children === "vpnDownload.pause")!.props.disabled).toBe(false);
  finish(); await promise;
  value.plans = [{ ...activePlan(), ranges: [{ ...activePlan().ranges[0]!, challenge: null, pauseReason: null }, { ...activePlan().ranges[1]!, phase: "paused", challenge: { kind: "cloudflare", url: "https://source.test" } }] }];
  const resolved = render(value);
  expect(controls(resolved.find(element => element.props["data-vpn-range"] === "lane-a")).some(element => element.props.children === "vpnDownload.openVerification")).toBe(false);
  expect(controls(resolved.find(element => element.props["data-vpn-range"] === "lane-b")).some(element => element.props.children === "vpnDownload.openVerification")).toBe(true);
});
