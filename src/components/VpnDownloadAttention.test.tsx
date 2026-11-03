import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "../lib/tasks/vpn-download-types";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  navigate: vi.fn(), resumeRun: vi.fn(), resumeRange: vi.fn(), verify: vi.fn(),
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({
  openVpnDownloadVerification: mocks.verify, resumeVpnDownloadRange: mocks.resumeRange, resumeVpnDownloadRun: mocks.resumeRun,
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}` }) }));
import { VpnDownloadAttention } from "./VpnDownloadAttention";

interface Props { children?: ReactNode; onClick?: () => unknown; "data-vpn-attention"?: string }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
function range(id: string, patch: Partial<VpnDownloadRangeState>): VpnDownloadRangeState {
  return { id, profileId: id, profileHash: "hash", startChapterId: 1, endChapterId: 2, chapterIds: [1, 2], selectedChapterIds: [1, 2], checkpoint: 0,
    phase: "paused", userPaused: false, pauseReason: null, attemptedProfileIds: [], attemptProfileId: null, generation: 1, challenge: null, ...patch };
}
function snapshot(ranges: VpnDownloadRangeState[], status: "running" | "interrupted" = "running"): VpnDownloadRuntimeSnapshot {
  const plan: VpnDownloadPlan = { id: "plan", batchId: "batch", pluginId: "source", novelId: 1, title: "Work", mode: "parallel",
    policies: { captcha: "pause", cloudflare: "pause" }, createdAt: 1, revision: 1, ranges };
  return { drafts: [], plans: [plan], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 2 }, chapterLabels: {},
    run: { id: "run", status, workerCount: 2, captchaPolicy: "pause", cloudflarePolicy: "pause", activeWorkers: 0, connectingWorkers: 0, closingWorkers: 0 } };
}
function render(value: VpnDownloadRuntimeSnapshot) {
  mocks.index = 0; mocks.refIndex = 0;
  return controls(VpnDownloadAttention({ snapshot: value }));
}
const press = (view: ReactElement<Props>[]) => view.find(element => element.props.onClick)!.props.onClick!();
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  for (const action of [mocks.resumeRun, mocks.resumeRange, mocks.verify]) action.mockResolvedValue(undefined);
});

it("renders nothing while VPN downloads only wait for the network, a busy server or the restart resume", () => {
  expect(render(snapshot([range("a", { pauseReason: "offline" }), range("b", { pauseReason: "profile-in-use" }), range("c", { pauseReason: "interrupted" })]))).toEqual([]);
});

it("offers one run-level Resume after a restart that did not resume automatically", async () => {
  const view = render(snapshot([range("a", { pauseReason: "interrupted" }), range("b", { pauseReason: "interrupted" })], "interrupted"));
  expect(view.find(element => element.props["data-vpn-attention"])?.props["data-vpn-attention"]).toBe("interrupted");
  expect(view.filter(element => element.props.onClick)).toHaveLength(1);
  await press(view);
  expect(mocks.resumeRun).toHaveBeenCalledOnce();
});

it("opens the exact verification session, sends exhaustion to server settings and retries failed parts", async () => {
  await press(render(snapshot([range("a", { pauseReason: "challenge-captcha", challenge: { kind: "captcha", url: "https://source.test" } })])));
  expect(mocks.verify).toHaveBeenCalledWith("plan", "a");
  await press(render(snapshot([range("a", { pauseReason: "profiles-exhausted" })])));
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "network" } });
  await press(render(snapshot([range("a", { pauseReason: "download-failed" }), range("b", { pauseReason: "runtime-error" })])));
  expect(mocks.resumeRange.mock.calls).toEqual([["plan", "a"], ["plan", "b"]]);
});

it("keeps a failed action visible on the line", async () => {
  mocks.resumeRun.mockRejectedValueOnce(new Error("VPN downloads are suspended for device restore."));
  const value = snapshot([range("a", { pauseReason: "interrupted" })], "interrupted");
  await press(render(value));
  expect(render(value).some(element => element.props.children === "VPN downloads are suspended for device restore.")).toBe(true);
});
