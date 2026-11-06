import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SavedVpnProfileVault } from "../lib/plugin-vpn-profiles";
import type { VpnDownloadProfileIssue } from "../lib/tasks/vpn-download-types";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], index: 0, refIndex: 0,
  vault: { data: undefined as SavedVpnProfileVault | undefined, isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  verdicts: { data: [] as { ip: string; verdict: "works" | "fails"; updatedAt: number }[], isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  issues: { data: [] as VpnDownloadProfileIssue[], isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  manual: { data: [] as { host: string; hash: string; savedAt: number }[], isPending: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  status: { data: { profile: null } as { profile: null | { hash: string; remoteHost: string; isVpnGateFinder: boolean } } },
  urlTestResults: {} as Record<string, { url: string; outcome: { kind: string } }>,
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
    : queryKey[0] === "vpn-download-profile-issues" ? mocks.issues : queryKey.length === 1 && queryKey[0] === "plugin-vpn" ? mocks.status
    : queryKey[2] === "manual" ? mocks.manual : mocks.vault,
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate, setQueryData: mocks.setData }),
}));
vi.mock("../lib/plugin-vpn-profiles", () => ({ SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "saved-profiles"], MANUAL_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "saved-profiles", "manual"],
  listSavedPluginVpnProfiles: vi.fn(), listManualPluginVpnProfiles: vi.fn(), setSavedPluginVpnProfileLimit: mocks.limit }));
vi.mock("../db/queries/vpn-gate-server-verdict", () => ({ listVpnGateServerVerdicts: vi.fn(), setVpnGateServerVerdict: mocks.revoke }));
vi.mock("../db/queries/vpn-download-profile-issues", () => ({ VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY: ["vpn-download-profile-issues"], listVpnDownloadProfileIssues: vi.fn() }));
vi.mock("../lib/plugin-vpn", () => ({ PLUGIN_VPN_QUERY_KEY: ["plugin-vpn"], getPluginVpnStatus: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ reallowVpnDownloadBatchProfile: mocks.reallow, notifyVpnDownloadProfilesChanged: mocks.profilesChanged }));
vi.mock("../i18n", () => ({
  useTranslation: () => ({ locale: "en", t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}` }),
  formatDateTimeForLocale: (_locale: string, value: number) => `date:${value}`,
}));
vi.mock("../store/plugin-vpn-url-test", () => ({
  usePluginVpnUrlTestStore: (select: (state: { results: Record<string, unknown> }) => unknown) => select({ results: mocks.urlTestResults }),
}));
import { SavedVpnProfilesSettings } from "./SavedVpnProfilesSettings";
import { PluginVpnSelectionPanel } from "./PluginVpnSelectionPanel";
import { IconButton } from "./IconButton";
import { ResponsiveSheet } from "./ui/ResponsiveSheet";
import { SettingsFieldRow, SettingsInlineControls } from "./SettingsPrimitives";
import { VpnGateServerVerdictControl } from "./VpnGateServerVerdictControl";

interface Props { children?: ReactNode; title?: ReactNode; error?: ReactNode; status?: string | null; className?: string; label?: string; "aria-label"?: string; value?: unknown; disabled?: boolean; opened?: boolean; min?: number; max?: number; onChange?: (value: number | string | null) => unknown; onClick?: () => unknown; data?: { value: string; disabled?: boolean }[]; ip?: string; verdict?: string | null; preferDisabledReason?: string | null }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
function render(disabled = false) { mocks.index = 0; mocks.refIndex = 0; return controls(SavedVpnProfilesSettings({ disabled })); }
const copy = (view: ReactElement<Props>[]) => view.flatMap(element =>
  [element.props.children, element.props.status, element.props.error].filter(text => typeof text === "string")).join(" ");
function openManager() { render().find(element => element.props.label === "settings.data.pluginVpn.saved.manage")!.props.onClick!(); return render(); }
const verdictControl = (view: ReactElement<Props>[], ip = "192.0.2.1") => view.find(element => element.type === VpnGateServerVerdictControl && element.props.ip === ip)!;
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  mocks.vault = { ...mocks.vault, data: { limit: 20, cleanupError: null, profiles: [{ id: "saved", ip: "192.0.2.1", protocol: "udp", hash: "a".repeat(64), approvedAt: 1234, approvalSequence: 1 }] }, isPending: false, isError: false, error: null };
  mocks.verdicts = { ...mocks.verdicts, data: [{ ip: "192.0.2.1", verdict: "works", updatedAt: 1 }, { ip: "192.0.2.2", verdict: "works", updatedAt: 1 }, { ip: "192.0.2.3", verdict: "fails", updatedAt: 1 }], isPending: false, isError: false, error: null };
  mocks.limit.mockResolvedValue({ limit: 10, profiles: mocks.vault.data!.profiles, cleanupError: null });
  mocks.revoke.mockResolvedValue({ verdict: null, savedProfile: null, cleanupError: null });
  mocks.issues = { ...mocks.issues, data: [], isError: false, isPending: false, error: null };
  mocks.manual = { ...mocks.manual, data: [], isError: false, isPending: false, error: null };
  mocks.status.data = { profile: null };
  mocks.urlTestResults = {};
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

const reallowButton = (view: ReactElement<Props>[]) => view.find(element => element.props.label === "settings.data.pluginVpn.saved.reallow")!;
const reallowAllButton = (view: ReactElement<Props>[]) => view.find(element => typeof element.props.label === "string" && element.props.label.startsWith("settings.data.pluginVpn.saved.reallowAll{"))!;

it.each(["works", "fails", null] as const)("does not manage a server without a saved file for a %s verdict and a download problem", verdict => {
  mocks.vault.data!.profiles = [];
  mocks.verdicts.data = verdict ? [{ ip: "192.0.2.1", verdict, updatedAt: 1 }] : [];
  mocks.issues.data = [issue("192.0.2.1")];
  const view = openManager();
  expect(reallowButton(view)).toBeUndefined();
  expect(reallowAllButton(view).props.disabled).toBe(true);
  expect(view.some(element => element.props["aria-label"] === "192.0.2.1")).toBe(false);
  expect(copy(view)).toContain("settings.data.pluginVpn.saved.noRecords");
});

it("allows every excluded saved profile across downloads while retaining other exclusions and history", async () => {
  mocks.issues.data = [issue("192.0.2.1"), issue("192.0.2.1", "batch-2"), issue("192.0.2.2"),
    issue("192.0.2.3"), issue("192.0.2.4"), issue("192.0.2.1", "batch-3", false)];
  const button = reallowAllButton(openManager());
  expect(button).toBeDefined();
  expect(button.props.label).toBe('settings.data.pluginVpn.saved.reallowAll{"count":1}');
  expect(button.props.disabled).toBe(false);
  await button.props.onClick!();
  expect(mocks.issues.data.map(issue => [issue.batchId, issue.ip, issue.excluded, issue.revision])).toEqual([
    ["batch-1", "192.0.2.1", false, 5], ["batch-2", "192.0.2.1", false, 5], ["batch-1", "192.0.2.2", true, 4],
    ["batch-1", "192.0.2.3", true, 4], ["batch-1", "192.0.2.4", true, 4], ["batch-3", "192.0.2.1", false, 4],
  ]);
  expect(mocks.issues.data.every(issue => issue.cause === "connection-failed" && issue.recordedAt === 1000)).toBe(true);
  expect(mocks.revoke).not.toHaveBeenCalled();
  expect(reallowAllButton(render()).props.disabled).toBe(true);
});

it("continues bulk reallow after a stale record and reports the partial failure", async () => {
  mocks.issues.data = [issue("192.0.2.1"), issue("192.0.2.1", "batch-2")];
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

it("keeps capacity inline and opens one modal listing only profiles with a saved file", () => {
  let view = render();
  expect(view.find(element => element.type === ResponsiveSheet)?.props.opened).toBe(false);
  view = openManager();
  expect(view.find(element => element.type === ResponsiveSheet)?.props.opened).toBe(true);
  const text = copy(view);
  expect(text).toContain('saved.count{"count":1,"limit":20}');
  expect(text).toContain("date:1234000");
  expect(view.filter(element => element.type === VpnGateServerVerdictControl).map(element => element.props.ip)).toEqual(["192.0.2.1"]);
});

it("filters saved profiles to recorded download or URL test connection failures", () => {
  mocks.manual.data = [{ host: "vpn.example.net", hash: "c".repeat(64), savedAt: 5 },
    { host: "vpn.example.org", hash: "d".repeat(64), savedAt: 6 }];
  mocks.issues.data = [{ ...issue("vpn.example.org"), cause: "captcha" }, issue("192.0.2.1")];
  mocks.urlTestResults = { "vpn.example.net": { url: "https://example.test/", outcome: { kind: "timedOut" } },
    "vpn.example.org": { url: "https://example.test/", outcome: { kind: "ok" } } };
  const rowIps = (view: ReactElement<Props>[]) => view.filter(element => element.type === VpnGateServerVerdictControl).map(element => element.props.ip);
  let view = openManager();
  expect(rowIps(view)).toEqual(["192.0.2.1", "vpn.example.net", "vpn.example.org"]);
  view.find(element => element.props.children === "settings.data.pluginVpn.saved.filter.failures")!.props.onClick!();
  view = render();
  expect(rowIps(view)).toEqual(["192.0.2.1", "vpn.example.net"]);
  mocks.issues.data = []; mocks.urlTestResults = {};
  expect(copy(render())).toContain("settings.data.pluginVpn.saved.noFilterMatches");
});

it("saves a valid capacity and invalidates saved-profile and verdict data", async () => {
  let view = render();
  const input = view.find(element => element.props["aria-label"] === "settings.data.pluginVpn.saved.limit")!;
  expect([input.props.min, input.props.max]).toEqual([1, 100]);
  input.props.onChange!(10);
  view = render();
  await view.find(element => element.props.label === "settings.data.pluginVpn.saved.saveLimit")!.props.onClick!();
  expect(mocks.limit).toHaveBeenCalledWith(10);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["plugin-vpn", "saved-profiles"] });
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["vpn-gate-server-verdicts"] });
});

it.each(["", 0, 101, 1.5])("does not save invalid profile capacity %s", async value => {
  render().find(element => element.props["aria-label"] === "settings.data.pluginVpn.saved.limit")!.props.onChange!(value);
  const save = render().find(element => element.props.label === "settings.data.pluginVpn.saved.saveLimit")!;
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
  expect(control.props.verdict).toBeNull();
  expect(control.props.preferDisabledReason).toBe("settings.data.pluginVpn.saved.approvalUnavailable");
});

it("shows native limit failures and retains the editable capacity without a false success", async () => {
  mocks.limit.mockRejectedValue(new Error("Capacity publication failed"));
  render().find(element => element.props["aria-label"] === "settings.data.pluginVpn.saved.limit")!.props.onChange!(10);
  await render().find(element => element.props.label === "settings.data.pluginVpn.saved.saveLimit")!.props.onClick!();
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

it("hides problem-only rows and separates a recorded batch exclusion from the user's O verdict", async () => {
  mocks.issues.data = [
    { batchId: "batch-1", planId: "plan", rangeId: "range-a", profileId: "saved", profileHash: "a".repeat(64),
      ip: "192.0.2.1", generation: 8, cause: "captcha", recordedAt: 1000, excluded: true, revision: 4 },
    { batchId: "batch-2", planId: "plan-2", rangeId: "range-b", profileId: "removed", profileHash: "b".repeat(64),
      ip: "192.0.2.4", generation: 9, cause: "connection-failed", recordedAt: 2000, excluded: false, revision: 2 },
  ];
  const view = openManager(); const text = copy(view);
  expect(text).not.toContain("192.0.2.4");
  expect(text).not.toContain("batch-2");
  expect(text).toContain("saved.cause.captcha");
  expect(text).toContain("batch-1");
  expect(text).toContain("date:1000");
  expect(verdictControl(view).props.verdict).toBe("works");
  await view.find(element => element.props.label === "settings.data.pluginVpn.saved.reallow")!.props.onClick!();
  expect(mocks.reallow).toHaveBeenCalledWith("batch-1", "192.0.2.1", 4);
  expect(mocks.revoke).not.toHaveBeenCalled();
});

it("lists Not used servers in their own modal that can only remove the mark", async () => {
  render().find(element => element.props.label === "settings.data.pluginVpn.blocked.manage")!.props.onClick!();
  const view = render();
  expect(view.filter(element => element.type === ResponsiveSheet).map(element => element.props.opened)).toEqual([false, false, true]);
  expect(view.some(element => element.type === VpnGateServerVerdictControl && element.props.ip === "192.0.2.3")).toBe(false);
  expect(copy(view)).toContain('blocked.since{"date":"date:1000"}');
  await view.find(element => element.props.label === 'settings.data.pluginVpn.blocked.unblock{"ip":"192.0.2.3"}')!.props.onClick!();
  expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith("192.0.2.3", null);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["vpn-gate-server-verdicts"] });
});

it("keeps a stale reallow error visible and refreshes the issue rather than claiming it was allowed", async () => {
  mocks.issues.data = [{ batchId: "batch", planId: "plan", rangeId: "range", generation: 8, profileId: "saved",
    profileHash: "a".repeat(64), ip: "192.0.2.1", cause: "cloudflare", recordedAt: 1000, excluded: true, revision: 4 }];
  mocks.reallow.mockRejectedValue(new Error("Stale issue revision"));
  await openManager().find(element => element.props.label === "settings.data.pluginVpn.saved.reallow")!.props.onClick!();
  expect(copy(render())).toContain("Stale issue revision");
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["vpn-download-profile-issues"] });
});

it("shows only the three most recent problems of a profile with the page causes", () => {
  mocks.issues.data = [
    { ...issue("192.0.2.1", "batch-1"), recordedAt: 1000, cause: "captcha" },
    { ...issue("192.0.2.1", "batch-2"), recordedAt: 4000, cause: "site-forbidden" },
    { ...issue("192.0.2.1", "batch-3"), recordedAt: 2000, cause: "connection-failed" },
    { ...issue("192.0.2.1", "batch-4"), recordedAt: 3000, cause: "page-unresponsive" },
  ];
  const text = copy(openManager());
  expect(text).toContain("saved.cause.site-forbidden");
  expect(text).toContain("saved.cause.page-unresponsive");
  expect(text).toContain("saved.cause.connection-failed");
  expect(text).not.toContain("saved.cause.captcha");
  expect(text.indexOf("saved.cause.site-forbidden")).toBeLessThan(text.indexOf("saved.cause.page-unresponsive"));
});

it("sorts saved profiles by name or date added in either direction", () => {
  mocks.vault.data!.profiles = [
    { id: "late", ip: "10.0.0.2", protocol: "udp", hash: "a".repeat(64), approvedAt: 300, approvalSequence: 2 },
    { id: "early", ip: "9.0.0.1", protocol: "udp", hash: "b".repeat(64), approvedAt: 100, approvalSequence: 1 },
  ];
  mocks.manual.data = [{ host: "vpn.example.net", hash: "c".repeat(64), savedAt: 200 }];
  const rowIps = (view: ReactElement<Props>[]) => view.filter(element => element.type === VpnGateServerVerdictControl).map(element => element.props.ip);
  const control = (view: ReactElement<Props>[], label: string) => view.find(element => element.props["aria-label"] === label || element.props.label === label)!;
  let view = openManager();
  expect(rowIps(view)).toEqual(["9.0.0.1", "10.0.0.2", "vpn.example.net"]);
  control(view, "library.viewOptions.sort").props.onClick!();
  view = render();
  const sheet = view.find(element => element.type === ResponsiveSheet && element.props.title === "library.viewOptions.sort")!;
  expect(sheet.props.opened).toBe(true);
  view.find(element => element.props.label === "library.viewOptions.sortBy")!.props.onChange!("added");
  view = render();
  expect(rowIps(view)).toEqual(["9.0.0.1", "vpn.example.net", "10.0.0.2"]);
  control(view, "library.viewOptions.direction").props.onChange!("desc");
  view = render();
  expect(rowIps(view)).toEqual(["10.0.0.2", "vpn.example.net", "9.0.0.1"]);
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

it("puts the counts and manage action on a labelled row and the capacity in a compact field beside its save icon", () => {
  const rows = render().filter(element => element.type === SettingsFieldRow) as ReactElement<Props>[];
  expect(rows.map(row => row.props.label)).toEqual(["settings.data.pluginVpn.saved.title", "settings.data.pluginVpn.blocked.title", "settings.data.pluginVpn.saved.limit"]);
  expect(rows[0]!.props.status).toBe('settings.data.pluginVpn.saved.count{"count":1,"limit":20}');
  expect(controls(rows[0]!.props.children).map(element => element.props.label)).toContain("settings.data.pluginVpn.saved.manage");
  expect(rows[1]!.props.status).toBe('settings.data.pluginVpn.blocked.count{"count":1}');
  expect(controls(rows[1]!.props.children).map(element => element.props.label)).toContain("settings.data.pluginVpn.blocked.manage");
  const capacity = controls(rows[2]!.props.children);
  expect(capacity[0]!.type).toBe(SettingsInlineControls);
  expect((capacity[0]!.props as { compact?: boolean }).compact).toBe(true);
  expect(capacity.find(element => element.props.label === "settings.data.pluginVpn.saved.saveLimit")).toBeDefined();
});

it("connects straight to a saved profile from its row and shows the one that is connecting", () => {
  const onConnect = vi.fn();
  mocks.index = 0; mocks.refIndex = 0;
  controls(SavedVpnProfilesSettings({ onConnect }));
  const opener = controls(SavedVpnProfilesSettings({ onConnect })).find(element => element.props.label === "settings.data.pluginVpn.saved.manage");
  opener?.props.onClick?.();
  mocks.index = 0; mocks.refIndex = 0;
  const view = controls(SavedVpnProfilesSettings({ onConnect }));
  const connect = view.filter(element => element.type === IconButton && String(element.props.label).startsWith("settings.data.pluginVpn.saved.connect"));
  expect(connect).toHaveLength(1);
  connect[0]!.props.onClick?.();
  expect(onConnect).toHaveBeenCalledWith({ id: "saved", hash: "a".repeat(64) });
  mocks.index = 0; mocks.refIndex = 0;
  const busy = controls(SavedVpnProfilesSettings({ connectingProfileId: "saved", onConnect }))
    .find(element => element.type === IconButton && String(element.props.label).startsWith("settings.data.pluginVpn.saved.connect"));
  expect(busy?.props.disabled).toBe(true);
});

it("lists an imported profile by its host with the same list toggles and Preferred from the active file", async () => {
  mocks.manual.data = [{ host: "vpn.example.com", hash: "d".repeat(64), savedAt: 5 }];
  mocks.verdicts.data = [...mocks.verdicts.data, { ip: "vpn.example.com", verdict: "works", updatedAt: 1 }];
  mocks.status.data.profile = { hash: "d".repeat(64), remoteHost: "vpn.example.com", isVpnGateFinder: false };
  const view = openManager();
  const text = copy(view);
  expect(text).toContain('saved.manualDetails{"date":"date:5000"}');
  expect(text).toContain('saved.manualCount{"count":1}');
  const control = verdictControl(view, "vpn.example.com");
  expect(control.props.verdict).toBe("works");
  expect(control.props.preferDisabledReason).toBeNull();
  await control.props.onChange!("fails");
  expect(mocks.revoke).toHaveBeenCalledWith("vpn.example.com", "fails");
  mocks.verdicts.data = mocks.verdicts.data.filter(row => row.ip !== "vpn.example.com");
  await verdictControl(render(), "vpn.example.com").props.onChange!("works");
  expect(mocks.revoke).toHaveBeenCalledWith("vpn.example.com", "works", { kind: "active", expectedHash: "d".repeat(64) });
});

function selectAll(): ReactElement<Props>[] {
  openManager().find(element => element.props.label === "library.selection.start")!.props.onClick!();
  const panel = render().find(element => element.type === PluginVpnSelectionPanel) as unknown as ReactElement<{ onSelectAll: () => void }>;
  panel.props.onSelectAll();
  return render();
}
type PanelProps = { actions?: unknown; count: number; testTargets: unknown[]; untestableCount: number };
const selectionPanel = (view: ReactElement<Props>[]) => view.find(element => element.type === PluginVpnSelectionPanel) as unknown as ReactElement<PanelProps>;

it("tests saved and imported profiles of the selection", () => {
  mocks.manual.data = [{ host: "vpn.example.net", hash: "c".repeat(64), savedAt: 5 }];
  const panel = selectionPanel(selectAll());
  expect(panel.props.actions).toBeUndefined();
  expect(panel.props.count).toBe(2);
  expect(panel.props.testTargets).toEqual([
    { host: "192.0.2.1", profile: { kind: "saved", id: "saved", expectedHash: "a".repeat(64) } },
    { host: "vpn.example.net", profile: { kind: "manual", host: "vpn.example.net", expectedHash: "c".repeat(64) } },
  ]);
  expect(panel.props.untestableCount).toBe(0);
});
