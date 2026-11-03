import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import koMessages from "../../strings/languages/ko/app.json";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";

const mocks = vi.hoisted(() => ({ snapshot: undefined as VpnDownloadRuntimeSnapshot | undefined, locale: "en" as "en" | "ko" }));
vi.mock("../i18n", async original => {
  const actual = await original<typeof import("../i18n")>();
  return { ...actual, useTranslation: () => ({ locale: mocks.locale,
    t: (key: Parameters<typeof actual.translate>[1], values?: Parameters<typeof actual.translate>[2]) => actual.translate(mocks.locale, key, values),
  }) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => ({
    data: queryKey[0] === "vpn-download-profile-issues" ? [] : queryKey[0] === "plugin-vpn" && queryKey.length === 1 ? { profile: null }
      : queryKey[0] === "vpn-gate-server-verdicts"
      ? [1, 2, 3].map(id => ({ ip: `192.0.2.${id}`, verdict: "works", updatedAt: 1 }))
      : { limit: 20, cleanupError: null, profiles: [1, 2].map(id => ({ id: `profile-${id}`, ip: `192.0.2.${id}`, protocol: "udp", hash: "a".repeat(64), approvedAt: 1, approvalSequence: id })) },
    isPending: false, isError: false, error: null, refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("../lib/plugin-vpn-profiles", () => ({
  SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "saved-profiles"], listSavedPluginVpnProfiles: vi.fn(), setSavedPluginVpnProfileLimit: vi.fn(),
}));
vi.mock("../db/queries/vpn-gate-server-verdict", () => ({ listVpnGateServerVerdicts: vi.fn(), setVpnGateServerVerdict: vi.fn() }));
vi.mock("../store/vpn-download", () => ({ useVpnDownloadStore: (select: (state: unknown) => unknown) => select({
  mode: "parallel", workerCount: 2, captchaPolicy: "pause", cloudflarePolicy: "pause",
  setMode: vi.fn(), setWorkerCount: vi.fn(), setCaptchaPolicy: vi.fn(), setCloudflarePolicy: vi.fn(),
}) }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({
  getVpnDownloadRuntimeSnapshot: () => mocks.snapshot,
  subscribeVpnDownloadRuntime: () => () => undefined,
  startVpnDownloadDraft: vi.fn(), cancelVpnDownloadDraft: vi.fn(), cancelVpnDownloadHandoverWork: vi.fn(), resumeVpnDownloadRange: vi.fn(),
  startVpnDownloadRun: vi.fn(), pauseVpnDownloadRun: vi.fn(), resumeVpnDownloadRun: vi.fn(), cancelVpnDownloadRun: vi.fn(),
  pauseVpnDownloadWork: vi.fn(), resumeVpnDownloadWork: vi.fn(),
  pauseVpnDownloadRange: vi.fn(), cancelVpnDownloadRange: vi.fn(), openVpnDownloadVerification: vi.fn(),
  reallowVpnDownloadBatchProfile: vi.fn(), notifyVpnDownloadProfilesChanged: vi.fn(),
}));
import { SavedVpnProfilesSettings } from "./SavedVpnProfilesSettings";
import { VpnDownloadPanel } from "./VpnDownloadPanel";
import { SettingsSection } from "./SettingsPrimitives";

it.each(["en", "ko"] as const)("renders real Mantine controls and resolved %s copy with bounded large-catalog markup", locale => {
  mocks.locale = locale;
  const chapters = Array.from({ length: 20_000 }, (_, index) => ({ id: index + 1, name: `Chapter ${index + 1}`, chapterNumber: String(index + 1) }));
  mocks.snapshot = {
    drafts: [{ id: "draft", batchId: "batch", title: "Catalog fixture", pluginId: "source", novelId: 42, chapters, selectedChapterIds: [1, 10_000, 20_000], error: null }],
    plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 2 }, chapterLabels: {},
  };
  const html = renderToStaticMarkup(<MantineProvider>
    <SettingsSection title="Plugin VPN"><SavedVpnProfilesSettings /></SettingsSection>
    <VpnDownloadPanel snapshot={mocks.snapshot} />
  </MantineProvider>);
  const $ = load(html);
  expect($("input").length).toBeLessThan(20);
  expect($("*").length).toBeLessThan(600);
  const launch = $("button").filter((_, element) => $(element).text() === (locale === "en" ? "Download with VPN" : koMessages["vpnDownload.launch"]));
  expect(launch.length).toBe(1);
  expect(launch.attr("disabled")).toBeUndefined();
  expect($(".norea-vpn-download-queue input").length).toBe(0);
  expect($(".norea-vpn-download-queue select").length).toBe(0);
  expect($.text()).toContain(locale === "en" ? "Saved profiles: 2 / 20" : koMessages["settings.data.pluginVpn.saved.count"].replace("{count}", "2").replace("{limit}", "20"));
  expect($.text()).toContain(locale === "en" ? "O-marked servers without a saved file: 1" : koMessages["settings.data.pluginVpn.saved.missingFiles"].replace("{count}", "1"));
  expect($.text()).not.toContain("vpnDownload.");
  expect($.text()).not.toContain("settings.data.pluginVpn.saved.");
});
