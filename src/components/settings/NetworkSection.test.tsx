import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLUGIN_VPN_QUERY_KEY, type PluginVpnStatus } from "../../lib/plugin-vpn";
import { NetworkSection } from "./NetworkSection";

function render(status: PluginVpnStatus): string {
  const client = new QueryClient();
  client.setQueryData(PLUGIN_VPN_QUERY_KEY, status);
  client.setQueryData(["vpn-gate-server-verdicts"], []);
  return renderToStaticMarkup(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <NetworkSection isBusy={false} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

function credentialsToggle(markup: string): string | undefined {
  return markup.match(/<button[^>]*aria-expanded="(true|false)"[^>]*class="norea-settings-advanced-toggle[^>]*><span[^>]*>Connection credentials</)?.[1];
}

const profile = { hash: "abc", isVpnGateFinder: false, remoteHost: "vpn.example.test" };

describe("network settings", () => {
  it("opens the credentials when the profile requires them", () => {
    const markup = render({
      error: null, phase: "disabled", proxyPort: 0, supported: true,
      profile: { ...profile, requiresUsernamePassword: true },
    });
    expect(credentialsToggle(markup)).toBe("true");
  });

  it("keeps optional credentials and the advanced rows collapsed", () => {
    const markup = render({
      error: null, phase: "disabled", proxyPort: 0, supported: true,
      profile: { ...profile, requiresUsernamePassword: false },
    });
    expect(credentialsToggle(markup)).toBe("false");
    expect(markup).toMatch(/aria-expanded="false"[^>]*class="norea-settings-advanced-toggle[^>]*><span[^>]*>Advanced</);
    expect(markup).not.toContain("norea-storage-setup-error");
  });

  it("puts the connected VPN Gate server's list toggles inside its profile value box", () => {
    const markup = render({
      error: null, phase: "connected", proxyPort: 1080, supported: true,
      profile: { hash: "abc", isVpnGateFinder: true, remoteHost: "192.0.2.10", requiresUsernamePassword: false },
    });
    const profileRow = markup.indexOf('data-settings-label="OpenVPN profile"');
    const advanced = markup.indexOf('class="norea-settings-advanced"');
    expect(profileRow).toBeGreaterThan(-1);
    expect(markup).not.toContain('data-settings-label="Current server"');
    expect(markup.slice(profileRow, advanced)).toMatch(
      /class="norea-settings-path-value norea-settings-profile-host"><span class="norea-settings-profile-host-text">192\.0\.2\.10<\/span><span[^>]*class="norea-vpn-gate-verdict-control"/,
    );
  });

  it("gives a manually imported profile the same list toggles, keyed by its host", () => {
    const markup = render({
      error: null, phase: "disabled", proxyPort: 0, supported: true,
      profile: { ...profile, requiresUsernamePassword: false },
    });
    expect(markup).toMatch(
      /<span class="norea-settings-profile-host-text">vpn\.example\.test<\/span><span[^>]*aria-label="[^"]*vpn\.example\.test[^"]*"[^>]*class="norea-vpn-gate-verdict-control"/,
    );
  });
});
