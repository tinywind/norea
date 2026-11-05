import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomaticVpnProfile } from "../lib/plugin-vpn-automatic";

const mocks = vi.hoisted(() => ({
  servers: [] as AutomaticVpnProfile[],
  mutation: null as null | {
    mutationFn: () => Promise<unknown>;
    onSettled: () => Promise<unknown>;
    onSuccess: (approved: unknown[]) => void;
  },
  approve: vi.fn(),
  invalidate: vi.fn(),
  profilesChanged: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: NonNullable<typeof mocks.mutation>) => {
    mocks.mutation = options;
    return { isPending: false, mutate: vi.fn() };
  },
  useQuery: () => ({ data: mocks.servers, isError: false, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("../lib/plugin-vpn-automatic", () => ({
  AUTOMATIC_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "automatic-profiles"],
  approveWorkingAutomaticPluginVpnProfiles: mocks.approve,
  listAutomaticPluginVpnProfiles: vi.fn(),
}));
vi.mock("../lib/plugin-vpn-profiles", () => ({
  SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY: ["plugin-vpn", "saved-profiles"],
}));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({
  notifyVpnDownloadProfilesChanged: mocks.profilesChanged,
}));
vi.mock("./settings/settings-toast", () => ({ showSettingsToast: mocks.toast }));

import { isWorkingTestedServer, TestedVpnServers } from "./TestedVpnServers";

function server(ip: string, failures = 0): AutomaticVpnProfile {
  return { failures, hash: ip.padEnd(64, "0"), id: ip, ip, protocol: "tcp", score: 1, testedAt: 1 };
}

function render(disabled = false) {
  return load(
    renderToStaticMarkup(
      <MantineProvider>
        <TestedVpnServers disabled={disabled} />
      </MantineProvider>,
    ),
  );
}

describe("TestedVpnServers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.servers = [server("192.0.2.1"), server("192.0.2.2", 2)];
  });

  it("lists tested servers with their result apart from any O/X verdict", () => {
    const $ = render();

    expect($("body").text()).toContain("2 tested · 1 working");
    expect($(".norea-tested-vpn-server")).toHaveLength(2);
    expect($(".norea-tested-vpn-server").first().text()).toContain("Working");
    expect($(".norea-tested-vpn-server").last().text()).toContain("2 recent connection failures");
    expect($("body").text()).not.toMatch(/\bO\b|\bX\b/);
    expect(isWorkingTestedServer(server("x", 1))).toBe(false);
  });

  it("offers Add all working to Preferred as one action counting only working servers", () => {
    const button = render()("button[aria-label^='Add all working to Preferred']");

    expect(button).toHaveLength(1);
    expect(button.attr("aria-label")).toBe("Add all working to Preferred (1)");
    expect(button.attr("disabled")).toBeUndefined();
  });

  it("disables Add all working to Preferred when nothing works or settings are busy", () => {
    expect(render(true)("button[aria-label^='Add all working to Preferred']").attr("disabled")).toBeDefined();
    mocks.servers = [server("192.0.2.2", 1)];
    expect(render()("button[aria-label^='Add all working to Preferred']").attr("disabled")).toBeDefined();
    mocks.servers = [];
    expect(render()("body").text()).toContain("No tested servers yet");
  });

  it("approves, tells the VPN downloads about the new preferred files and refreshes every pool view", async () => {
    render();
    const approved = [{ id: "a", ip: "192.0.2.1" }];
    mocks.approve.mockResolvedValue(approved);

    await expect(mocks.mutation!.mutationFn()).resolves.toBe(approved);
    mocks.mutation!.onSuccess(approved);
    await mocks.mutation!.onSettled();

    expect(mocks.profilesChanged).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith("ok", "Added 1 servers to Preferred");
    expect(mocks.invalidate.mock.calls.map(([{ queryKey }]) => queryKey[1] ?? queryKey[0])).toEqual([
      "automatic-profiles",
      "saved-profiles",
      "vpn-gate-server-verdicts",
    ]);
  });
});
