import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";

const mocks = vi.hoisted(() => ({
  snapshot: undefined as VpnDownloadRuntimeSnapshot | undefined,
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  start: vi.fn(), close: vi.fn(),
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
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ startVpnDownloadRun: mocks.start }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { VpnDownloadLaunchDialog } from "./VpnDownloadLaunchDialog";
import { VpnDownloadSettings } from "./VpnDownloadSettings";

interface Props {
  children?: ReactNode;
  opened?: boolean;
  disabled?: boolean;
  onClick?: () => unknown;
  onClose?: () => void;
  closeLabel?: string;
  footer?: ReactNode;
  value?: unknown;
  onChange?: (value: unknown) => void;
}
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children), ...elements(element.props.footer)];
}
let snapshot: VpnDownloadRuntimeSnapshot;
function render() {
  mocks.index = 0; mocks.refIndex = 0;
  mocks.snapshot = snapshot;
  return elements(VpnDownloadLaunchDialog({ snapshot, onClose: mocks.close }));
}
const button = (view: ReactElement<Props>[], label: string) => view.find(element => element.props.children === label)!;
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  snapshot = { drafts: [], plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 10 }, chapterLabels: {} };
  mocks.vault.isPending = false; mocks.vault.isError = false; mocks.vault.error = null; mocks.vault.data.cleanupError = null;
  mocks.vault.data.profiles = [{ id: "profile", ip: "192.0.2.1", protocol: "udp", hash: "a".repeat(64), approvedAt: 1, approvalSequence: 1 }];
  mocks.start.mockReset().mockResolvedValue(undefined);
});

it("dismisses the launch modal without starting work or changing stored choices", async () => {
  expect(render().find(element => element.props.opened)?.props.opened).toBe(true);
  await button(render(), "common.cancel").props.onClick!();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.settings).toEqual({ workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile" });
});

it("labels the modal's close control for keyboard and screen-reader cancellation", () => {
  const modal = render().find(element => element.props.opened)!;
  expect(modal.props.closeLabel).toBe("common.cancel");
});

it("starts all queued work with accepted defaults and coalesces duplicate submissions", async () => {
  let finish!: () => void;
  mocks.start.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const submit = button(render(), "vpnDownload.start");
  const first = submit.props.onClick!();
  const second = submit.props.onClick!();
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith({ workerCount: 2, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile" });
  expect(button(render(), "common.cancel").props.disabled).toBe(true);
  await button(render(), "common.cancel").props.onClick!();
  expect(mocks.close).not.toHaveBeenCalled();
  finish(); await Promise.all([first, second]);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("keeps the modal open with the failure when the run cannot start", async () => {
  mocks.start.mockRejectedValueOnce(new Error("A VPN download run is already active."));
  await button(render(), "vpnDownload.start").props.onClick!();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(render().some(element => element.props.children === "A VPN download run is already active.")).toBe(true);
});

it("keeps optional edits local until Start is accepted", async () => {
  const editor = render().find(element => element.type === VpnDownloadSettings)!;
  editor.props.onChange!({ workerCount: 10, captchaPolicy: "pause", cloudflarePolicy: "nextProfile" });
  expect(mocks.settings.workerCount).toBe(2);
  await button(render(), "vpnDownload.start").props.onClick!();
  expect(mocks.start).toHaveBeenCalledWith({ workerCount: 10, captchaPolicy: "pause", cloudflarePolicy: "nextProfile" });
});

it("explains missing profiles while allowing automatic waiting without per-work setup", async () => {
  mocks.vault.data.profiles = [];
  expect(render().some(element => element.props.children === "vpnDownload.noProfiles")).toBe(true);
  expect(button(render(), "vpnDownload.start").props.disabled).toBe(false);
});

it("blocks unsupported execution and profile cleanup errors with visible reasons", async () => {
  snapshot.capabilities = { supported: false, parallelSupported: false, maxWorkers: 0 };
  mocks.vault.data.cleanupError = "Saved file cleanup failed";
  const view = render();
  expect(view.some(element => element.props.children === "vpnDownload.unsupported")).toBe(true);
  expect(view.some(element => element.props.children === "Saved file cleanup failed")).toBe(true);
  expect(button(view, "vpnDownload.start").props.disabled).toBe(true);
  await button(view, "vpnDownload.start").props.onClick!();
  expect(mocks.start).not.toHaveBeenCalled();
});
