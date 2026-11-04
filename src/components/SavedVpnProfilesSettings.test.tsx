import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SavedVpnProfileVault } from "../lib/plugin-vpn-profiles";
import type { VpnDownloadProfileIssue } from "../lib/tasks/vpn-download-types";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  vault: { data: undefined as SavedVpnProfileVault | undefined, isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  verdicts: { data: [] as { ip: string; verdict: "works" | "fails"; updatedAt: number }[], isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  issues: { data: [] as VpnDownloadProfileIssue[], isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  status: { data: { profile: null } as { profile: null | { hash: string; remoteHost: string; isVpnGateFinder: boolean } } },
  reallow: vi.fn(), profilesChanged: vi.fn(),
  limit: vi.fn(), revoke: vi.fn(), invalidate: vi.fn(), setData: vi.fn(),
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
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => queryKey[0] === "vpn-gate-server-verdicts" ? mocks.verdicts
    : queryKey[0] === "vpn-download-profile-issues" ? mocks.issues : queryKey.length === 1 && queryKey[0] === "plugin-vpn" ? mocks.status : mocks.vault,
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate, setQueryData: mocks.setData }),
}));
vi.mock("../lib/plugin-vpn-profiles", () => ({ SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "saved-profiles"], listSavedPluginVpnProfiles: vi.fn(), setSavedPluginVpnProfileLimit: mocks.limit }));
vi.mock("../db/queries/vpn-gate-server-verdict", () => ({ listVpnGateServerVerdicts: vi.fn(), setVpnGateServerVerdict: mocks.revoke }));
vi.mock("../db/queries/vpn-download-profile-issues", () => ({ VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY: ["vpn-download-profile-issues"], listVpnDownloadProfileIssues: vi.fn() }));
vi.mock("../lib/plugin-vpn", () => ({ PLUGIN_VPN_QUERY_KEY: ["plugin-vpn"], getPluginVpnStatus: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ reallowVpnDownloadBatchProfile: mocks.reallow, notifyVpnDownloadProfilesChanged: mocks.profilesChanged }));
vi.mock("../i18n", () => ({
  useTranslation: () => ({ locale: "en", t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}` }),
  formatDateTimeForLocale: (_locale: string, value: number) => `date:${value}`,
}));
import { SavedVpnProfilesSettings } from "./SavedVpnProfilesSettings";
import { ResponsiveSheet } from "./ui/ResponsiveSheet";

interface Props { children?: ReactNode; "aria-label"?: string; value?: unknown; disabled?: boolean; opened?: boolean; min?: number; max?: number; onChange?: (value: number | string | null) => unknown; onClick?: () => unknown; data?: { value: string; disabled?: boolean }[] }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
function render(disabled = false) { mocks.index = 0; mocks.refIndex = 0; return controls(SavedVpnProfilesSettings({ disabled })); }
const copy = (view: ReactElement<Props>[]) => view.map(element => typeof element.props.children === "string" ? element.props.children : "").join(" ");
function openManager() { render().find(element => element.props.children === "settings.data.pluginVpn.saved.manage")!.props.onClick!(); return render(); }
const verdictControl = (view: ReactElement<Props>[], ip = "192.0.2.1") => view.find(element => element.props["aria-label"] === `settings.data.pluginVpn.saved.verdictLabel{"ip":"${ip}"}`)!;
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  mocks.vault = { ...mocks.vault, data: { limit: 20, cleanupError: null, profiles: [{ id: "saved", ip: "192.0.2.1", protocol: "udp", hash: "a".repeat(64), approvedAt: 1234, approvalSequence: 1 }] }, isPending: false, isError: false, error: null };
  mocks.verdicts = { ...mocks.verdicts, data: [{ ip: "192.0.2.1", verdict: "works", updatedAt: 1 }, { ip: "192.0.2.2", verdict: "works", updatedAt: 1 }, { ip: "192.0.2.3", verdict: "fails", updatedAt: 1 }], isPending: false, isError: false, error: null };
  mocks.limit.mockResolvedValue({ limit: 10, profiles: mocks.vault.data!.profiles, cleanupError: null });
  mocks.revoke.mockResolvedValue({ verdict: null, savedProfile: null, cleanupError: null });
  mocks.issues = { ...mocks.issues, data: [], isError: false, isPending: false, error: null };
  mocks.status.data = { profile: null };
  mocks.reallow.mockImplementation(async (batchId: string, ip: string, revision: number) => {
    const issue = mocks.issues.data.find(issue => issue.batchId === batchId && issue.ip === ip);
    if (!issue?.excluded || issue.revision !== revision) throw new Error("Stale issue revision");
    issue.excluded = false;
    issue.revision++;
  });
  mocks.profilesChanged.mockResolvedValue(undefined);
});

function issue(ip: string, batchId = "batch-1", excluded = true): VpnDownloadProfileIssue {
  return { batchId, planId: `plan-${batchId}`, rangeId: "range", profileId: "saved", profileHash: "a".repeat(64),
    ip, generation: 8, cause: "connection-failed", recordedAt: 1000, excluded, revision: 4 };
}

const reallowButton = (view: ReactElement<Props>[]) => view.find(element => element.props.children === "settings.data.pluginVpn.saved.reallow")!;
const reallowAllButton = (view: ReactElement<Props>[]) => view.find(element => typeof element.props.children === "string" && element.props.children.startsWith("settings.data.pluginVpn.saved.reallowAll{"))!;

it.each(["works", "fails", null] as const)("can clear a download exclusion without a saved file while preserving the %s verdict", async verdict => {
  mocks.vault.data!.profiles = [];
  mocks.verdicts.data = verdict ? [{ ip: "192.0.2.1", verdict, updatedAt: 1 }] : [];
  mocks.issues.data = [issue("192.0.2.1")];
  const button = reallowButton(openManager());
  expect(button.props.disabled).toBe(false);
  await button.props.onClick!();
  const text = copy(render());
  expect(text).toContain("settings.data.pluginVpn.saved.allowed");
  expect(text).toContain("settings.data.pluginVpn.saved.cause.connection-failed");
  expect(mocks.revoke).not.toHaveBeenCalled();
  expect(mocks.issues.data[0]).toMatchObject({ excluded: false, revision: 5 });
});

it("allows every excluded O profile across downloads, including missing files, while retaining other exclusions and history", async () => {
  mocks.issues.data = [issue("192.0.2.1"), issue("192.0.2.1", "batch-2"), issue("192.0.2.2"),
    issue("192.0.2.3"), issue("192.0.2.4"), issue("192.0.2.1", "batch-3", false)];
  const button = reallowAllButton(openManager());
  expect(button).toBeDefined();
  expect(button.props.children).toBe('settings.data.pluginVpn.saved.reallowAll{"count":2}');
  expect(button.props.disabled).toBe(false);
  await button.props.onClick!();
  expect(mocks.issues.data.map(issue => [issue.batchId, issue.ip, issue.excluded, issue.revision])).toEqual([
    ["batch-1", "192.0.2.1", false, 5], ["batch-2", "192.0.2.1", false, 5], ["batch-1", "192.0.2.2", false, 5],
    ["batch-1", "192.0.2.3", true, 4], ["batch-1", "192.0.2.4", true, 4], ["batch-3", "192.0.2.1", false, 4],
  ]);
  expect(mocks.issues.data.every(issue => issue.cause === "connection-failed" && issue.recordedAt === 1000)).toBe(true);
  expect(mocks.revoke).not.toHaveBeenCalled();
  expect(reallowAllButton(render()).props.disabled).toBe(true);
});

it("continues bulk reallow after a stale record and reports the partial failure", async () => {
  mocks.issues.data = [issue("192.0.2.1"), issue("192.0.2.2")];
  mocks.reallow.mockRejectedValueOnce(new Error("Stale issue revision"));
  const button = reallowAllButton(openManager());
  expect(button).toBeDefined();
  await button.props.onClick!();
  expect(mocks.issues.data.map(issue => issue.excluded)).toEqual([true, false]);
  expect(copy(render())).toContain('saved.reallowAllFailed{"count":1,"error":"Stale issue revision"}');
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["vpn-download-profile-issues"] });
});

it("locks reallow actions while a bulk request is pending and rejects duplicate submissions", async () => {
  mocks.issues.data = [issue("192.0.2.1")];
  let finish!: () => void;
  mocks.reallow.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const button = reallowAllButton(openManager());
  expect(button).toBeDefined();
  const request = button.props.onClick!();
  expect(reallowAllButton(render()).props.disabled).toBe(true);
  expect(reallowButton(render()).props.disabled).toBe(true);
  await button.props.onClick!();
  expect(mocks.reallow).toHaveBeenCalledTimes(1);
  finish();
  await request;
  expect(reallowAllButton(render()).props.disabled).toBe(false);
});

it.each(["loading", "error", "disabled"])("does not reallow profiles while management is %s", async state => {
  mocks.issues.data = [issue("192.0.2.1")];
  openManager();
  if (state === "loading") mocks.issues.isPending = true;
  if (state === "error") mocks.issues.isError = true;
  const view = render(state === "disabled");
  for (const button of [reallowButton(view), reallowAllButton(view)]) {
    expect(button.props.disabled).toBe(true);
    await button.props.onClick!();
  }
  expect(mocks.issues.data[0]).toMatchObject({ excluded: true, revision: 4 });
  expect(mocks.reallow).not.toHaveBeenCalled();
});

it("keeps capacity inline and opens one modal combining retained files with O/X-only verdicts", () => {
  let view = render();
  expect(view.find(element => element.type === ResponsiveSheet)?.props.opened).toBe(false);
  view = openManager();
  expect(view.find(element => element.type === ResponsiveSheet)?.props.opened).toBe(true);
  const text = copy(view);
  expect(text).toContain('saved.count{"count":1,"limit":20}');
  expect(text).toContain('saved.missingFiles{"count":1}');
  expect(text).toContain("192.0.2.1");
  expect(text).toContain("date:1234000");
  expect(text).toContain("192.0.2.3");
  expect(verdictControl(view, "192.0.2.3").props.value).toBe("fails");
});

it("saves a valid capacity and invalidates saved-profile and verdict data", async () => {
  let view = render();
  const input = view.find(element => element.props["aria-label"] === "settings.data.pluginVpn.saved.limit")!;
  expect([input.props.min, input.props.max]).toEqual([1, 100]);
  input.props.onChange!(10);
  view = render();
  await view.find(element => element.props.children === "common.save")!.props.onClick!();
  expect(mocks.limit).toHaveBeenCalledWith(10);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["plugin-vpn", "saved-profiles"] });
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["vpn-gate-server-verdicts"] });
});

it.each(["", 0, 101, 1.5])("does not save invalid profile capacity %s", async value => {
  render().find(element => element.props["aria-label"] === "settings.data.pluginVpn.saved.limit")!.props.onChange!(value);
  const save = render().find(element => element.props.children === "common.save")!;
  expect(save.props.disabled).toBe(true);
  await save.props.onClick!();
  expect(mocks.limit).not.toHaveBeenCalled();
});

it("revokes through the verdict service and never creates O without exact native bytes", async () => {
  const control = verdictControl(openManager());
  await control.props.onChange!("fails");
  expect(mocks.revoke).toHaveBeenCalledWith("192.0.2.1", "fails");
  await control.props.onChange!("works");
  expect(mocks.revoke).toHaveBeenCalledTimes(1);
});

it("does not infer approval from retained metadata when its actual verdict is absent", () => {
  mocks.verdicts.data = [];
  const control = verdictControl(openManager());
  expect(control.props.value).toBe("unmarked");
  expect(control.props.data?.find(option => option.value === "works")?.disabled).toBe(true);
});

it("shows native limit failures and retains the editable capacity without a false success", async () => {
  mocks.limit.mockRejectedValue(new Error("Capacity publication failed"));
  render().find(element => element.props["aria-label"] === "settings.data.pluginVpn.saved.limit")!.props.onChange!(10);
  await render().find(element => element.props.children === "common.save")!.props.onClick!();
  const view = render();
  expect(copy(view)).toContain("Capacity publication failed");
  expect(view.find(element => element.props["aria-label"] === "settings.data.pluginVpn.saved.limit")!.props.value).toBe(10);
  expect(mocks.setData).not.toHaveBeenCalled();
});

it("disables conflicting edits during revocation and exposes cleanup failures", async () => {
  let finish!: (value: unknown) => void;
  mocks.revoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const request = verdictControl(openManager()).props.onChange!("fails");
  expect(render().find(element => element.props["aria-label"] === "settings.data.pluginVpn.saved.limit")!.props.disabled).toBe(true);
  finish({ cleanupError: "Could not remove saved profile", verdict: null, savedProfile: null });
  await request;
  expect(copy(render())).toContain("Could not remove saved profile");
});

it("shows problem-only rows and separates a recorded batch exclusion from the user's O verdict", async () => {
  mocks.issues.data = [
    { batchId: "batch-1", planId: "plan", rangeId: "range-a", profileId: "saved", profileHash: "a".repeat(64),
      ip: "192.0.2.1", generation: 8, cause: "captcha", recordedAt: 1000, excluded: true, revision: 4 },
    { batchId: "batch-2", planId: "plan-2", rangeId: "range-b", profileId: "removed", profileHash: "b".repeat(64),
      ip: "192.0.2.4", generation: 9, cause: "connection-failed", recordedAt: 2000, excluded: false, revision: 2 },
  ];
  const view = openManager(); const text = copy(view);
  expect(text).toContain("192.0.2.4");
  expect(text).toContain("saved.cause.captcha");
  expect(text).toContain("batch-1");
  expect(text).toContain("date:1000");
  expect(verdictControl(view).props.value).toBe("works");
  await view.find(element => element.props.children === "settings.data.pluginVpn.saved.reallow")!.props.onClick!();
  expect(mocks.reallow).toHaveBeenCalledWith("batch-1", "192.0.2.1", 4);
  expect(mocks.revoke).not.toHaveBeenCalled();
});

it("can mark a historical X as O only from the exact active native file", async () => {
  mocks.status.data.profile = { hash: "c".repeat(64), remoteHost: "192.0.2.3", isVpnGateFinder: true };
  const control = verdictControl(openManager(), "192.0.2.3");
  expect(control.props.data?.find(option => option.value === "works")?.disabled).not.toBe(true);
  await control.props.onChange!("works");
  expect(mocks.revoke).toHaveBeenCalledWith("192.0.2.3", "works", { kind: "active", expectedHash: "c".repeat(64) });
});

it("keeps a stale reallow error visible and refreshes the issue rather than claiming it was allowed", async () => {
  mocks.issues.data = [{ batchId: "batch", planId: "plan", rangeId: "range", generation: 8, profileId: "saved",
    profileHash: "a".repeat(64), ip: "192.0.2.1", cause: "cloudflare", recordedAt: 1000, excluded: true, revision: 4 }];
  mocks.reallow.mockRejectedValue(new Error("Stale issue revision"));
  await openManager().find(element => element.props.children === "settings.data.pluginVpn.saved.reallow")!.props.onClick!();
  expect(copy(render())).toContain("Stale issue revision");
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["vpn-download-profile-issues"] });
});

it("keeps loading and query failures distinct from a real empty vault", () => {
  mocks.vault.data = undefined; mocks.vault.isPending = true;
  expect(copy(render())).toContain("settings.data.pluginVpn.saved.loading");
  mocks.vault.isPending = false; mocks.vault.isError = true; mocks.vault.error = new Error("Vault unavailable");
  expect(copy(render())).toContain("Vault unavailable");
  expect(copy(render())).not.toContain("settings.data.pluginVpn.saved.empty");
  mocks.vault.isError = false; mocks.vault.error = null; mocks.vault.data = { limit: 20, profiles: [], cleanupError: null };
  expect(copy(render())).toContain("settings.data.pluginVpn.saved.empty");
});
