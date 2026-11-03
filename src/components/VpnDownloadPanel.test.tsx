import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";

const mocks = vi.hoisted(() => ({
  snapshot: undefined as VpnDownloadRuntimeSnapshot | undefined,
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  start: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
  settings: { workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile" },
  vault: { data: { limit: 20, cleanupError: null as string | null, profiles: [{ id: "profile", ip: "192.0.2.1", protocol: "udp", hash: "a".repeat(64), approvedAt: 1, approvalSequence: 1 }] }, isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.index++;
    if (!(index in mocks.states)) mocks.states[index] = typeof initial === "function" ? initial() : initial;
    return [mocks.states[index], (next: unknown) => { mocks.states[index] = typeof next === "function" ? next(mocks.states[index]) : next; }];
  },
  useRef: (initial: unknown) => mocks.refs[mocks.refIndex++] ?? (mocks.refs[mocks.refIndex - 1] = { current: initial }),
  useSyncExternalStore: () => mocks.snapshot,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => mocks.vault }));
vi.mock("../store/vpn-download", () => ({ useVpnDownloadStore: (select: (value: typeof mocks.settings) => unknown) => select(mocks.settings) }));
vi.mock("../lib/plugin-vpn-profiles", () => ({ SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "saved-profiles"], listSavedPluginVpnProfiles: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({
  getVpnDownloadRuntimeSnapshot: () => mocks.snapshot, subscribeVpnDownloadRuntime: () => () => undefined, startVpnDownloadDraft: vi.fn(),
  startVpnDownloadRun: mocks.start, pauseVpnDownloadRun: mocks.pause, resumeVpnDownloadRun: mocks.resume, cancelVpnDownloadRun: mocks.cancel,
  pauseVpnDownloadWork: vi.fn(), resumeVpnDownloadWork: vi.fn(),
  cancelVpnDownloadDraft: vi.fn(), cancelVpnDownloadHandoverWork: vi.fn(), resumeVpnDownloadRange: vi.fn(), pauseVpnDownloadRange: vi.fn(), cancelVpnDownloadRange: vi.fn(), openVpnDownloadVerification: vi.fn(),
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { VpnDownloadPanel } from "./VpnDownloadPanel";
import { VpnDownloadSettings } from "./VpnDownloadSettings";

interface Props {
  children?: ReactNode;
  opened?: boolean;
  disabled?: boolean;
  onClick?: () => unknown;
  onClose?: () => void;
  closeButtonProps?: { "aria-label"?: string };
  value?: unknown;
  onChange?: (value: unknown) => void;
}
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children)];
}
let snapshot: VpnDownloadRuntimeSnapshot;
function render() {
  mocks.index = 0; mocks.refIndex = 0;
  mocks.snapshot = snapshot;
  return elements(VpnDownloadPanel({ snapshot }));
}
const button = (view: ReactElement<Props>[], label: string) => view.find(element => element.props.children === label)!;
const open = () => button(render(), "vpnDownload.launch").props.onClick!();
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  snapshot = { drafts: [], plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 10 }, chapterLabels: {} };
  mocks.vault.isPending = false; mocks.vault.isError = false; mocks.vault.error = null; mocks.vault.data.cleanupError = null;
  mocks.vault.data.profiles = [{ id: "profile", ip: "192.0.2.1", protocol: "udp", hash: "a".repeat(64), approvedAt: 1, approvalSequence: 1 }];
  mocks.start.mockReset().mockResolvedValue(undefined);
  mocks.pause.mockReset().mockResolvedValue(undefined); mocks.resume.mockReset().mockResolvedValue(undefined); mocks.cancel.mockReset().mockResolvedValue(undefined);
});

it("dismisses the launch modal without starting work or changing stored choices", async () => {
  await open();
  expect(render().find(element => element.props.opened)?.props.opened).toBe(true);
  await button(render(), "common.cancel").props.onClick!();
  expect(render().some(element => element.props.opened)).toBe(false);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.settings).toEqual({ workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile" });
});

it("labels the modal's close control for keyboard and screen-reader cancellation", async () => {
  await open();
  const modal = render().find(element => element.props.opened)!;
  expect(modal.props.closeButtonProps?.["aria-label"]).toBe("common.cancel");
});

it("starts all queued work with accepted defaults and coalesces duplicate submissions", async () => {
  let finish!: () => void;
  mocks.start.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await open();
  const submit = button(render(), "vpnDownload.start");
  const first = submit.props.onClick!();
  const second = submit.props.onClick!();
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith({ workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile" });
  expect(button(render(), "common.cancel").props.disabled).toBe(true);
  finish(); await Promise.all([first, second]);
  expect(render().some(element => element.props.opened)).toBe(false);
});

it("keeps optional edits local until Start is accepted", async () => {
  await open();
  const editor = render().find(element => element.type === VpnDownloadSettings)!;
  editor.props.onChange!({ workerCount: 10, captchaPolicy: "pause", cloudflarePolicy: "nextProfile" });
  expect(mocks.settings.workerCount).toBe(2);
  await button(render(), "vpnDownload.start").props.onClick!();
  expect(mocks.start).toHaveBeenCalledWith({ workerCount: 10, captchaPolicy: "pause", cloudflarePolicy: "nextProfile" });
});

it("explains missing profiles while allowing automatic waiting without per-work setup", async () => {
  mocks.vault.data.profiles = [];
  await open();
  expect(render().some(element => element.props.children === "vpnDownload.noProfiles")).toBe(true);
  expect(button(render(), "vpnDownload.start").props.disabled).toBe(false);
});

it("blocks unsupported execution and profile cleanup errors with visible reasons", async () => {
  snapshot.capabilities = { supported: false, parallelSupported: false, maxWorkers: 0 };
  mocks.vault.data.cleanupError = "Saved file cleanup failed";
  await open();
  const view = render();
  expect(view.some(element => element.props.children === "vpnDownload.unsupported")).toBe(true);
  expect(view.some(element => element.props.children === "Saved file cleanup failed")).toBe(true);
  expect(button(view, "vpnDownload.start").props.disabled).toBe(true);
  await button(view, "vpnDownload.start").props.onClick!();
  expect(mocks.start).not.toHaveBeenCalled();
});

it.each(["paused", "interrupted"] as const)("offers Resume for a %s run instead of opening another launch modal", async status => {
  snapshot.run = { id: "run", status, workerCount: 3, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile", activeWorkers: 0, connectingWorkers: 0, closingWorkers: 0 };
  const view = render();
  expect(button(view, "vpnDownload.launch")).toBeUndefined();
  await button(view, "vpnDownload.resume").props.onClick!();
  expect(mocks.resume).toHaveBeenCalledOnce();
  await button(render(), "vpnDownload.cancelRun").props.onClick!();
  expect(mocks.cancel).toHaveBeenCalledOnce();
});
