import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";

const mocks = vi.hoisted(() => ({
  snapshot: undefined as VpnDownloadRuntimeSnapshot | undefined,
  externalStore: vi.fn(), subscribe: vi.fn(), getSnapshot: vi.fn(),
  start: vi.fn(), cancelDraft: vi.fn(), resume: vi.fn(), pause: vi.fn(), cancel: vi.fn(), verify: vi.fn(),
  vault: { data: { limit: 20, cleanupError: null as string | null, profiles: [{ id: "profile", ip: "192.0.2.1", protocol: "udp", hash: "a".repeat(64), approvedAt: 1, approvalSequence: 1 }] }, isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useSyncExternalStore: (...args: unknown[]) => { mocks.externalStore(...args); return mocks.snapshot; },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => mocks.vault }));
vi.mock("../lib/plugin-vpn-profiles", () => ({ SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "saved-profiles"], listSavedPluginVpnProfiles: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({
  getVpnDownloadRuntimeSnapshot: mocks.getSnapshot, subscribeVpnDownloadRuntime: mocks.subscribe,
  startVpnDownloadDraft: mocks.start, cancelVpnDownloadDraft: mocks.cancelDraft,
  resumeVpnDownloadRange: mocks.resume, pauseVpnDownloadRange: mocks.pause,
  cancelVpnDownloadRange: mocks.cancel, openVpnDownloadVerification: mocks.verify,
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { VpnDownloadPanel } from "./VpnDownloadPanel";
import { VpnDownloadRanges } from "./VpnDownloadRanges";
import { VpnDownloadSettings } from "./VpnDownloadSettings";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot = { drafts: [], plans: [], loading: false, error: null, capabilities: { supported: false, parallelSupported: false, maxWorkers: 0 }, chapterLabels: {} };
  mocks.vault.isPending = false; mocks.vault.isError = false; mocks.vault.error = null; mocks.vault.data.cleanupError = null;
});

it("subscribes to the canonical runtime and forwards capabilities and exact runtime actions", () => {
  const view = elements(VpnDownloadPanel());
  expect(mocks.externalStore).toHaveBeenCalledWith(mocks.subscribe, mocks.getSnapshot, mocks.getSnapshot);
  expect(view.find(element => element.type === VpnDownloadSettings)?.props.capabilities).toBe(mocks.snapshot!.capabilities);
  expect(view.find(element => element.type === VpnDownloadRanges)?.props.actions).toEqual({
    startDraft: mocks.start, cancelDraft: mocks.cancelDraft, resumeRange: mocks.resume,
    pauseRange: mocks.pause, cancelRange: mocks.cancel, openVerification: mocks.verify,
  });
});

it("fails closed for profile cleanup errors and keeps them visible", () => {
  mocks.vault.data.cleanupError = "Saved file cleanup failed";
  const view = elements(VpnDownloadPanel());
  const ranges = view.find(element => element.type === VpnDownloadRanges)!;
  expect(ranges.props.profilesReady).toBe(false);
  expect(view.some(element => element.props.children === "Saved file cleanup failed")).toBe(true);
});
