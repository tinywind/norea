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

  it("judges a connected VPN Gate server in a row right after the profile, outside Advanced", () => {
    const markup = render({
      error: null, phase: "connected", proxyPort: 1080, supported: true,
      profile: { hash: "abc", isVpnGateFinder: true, remoteHost: "192.0.2.10", requiresUsernamePassword: false },
    });
    const profileRow = markup.indexOf('data-settings-label="OpenVPN profile"');
    const verdictRow = markup.indexOf('data-settings-label="Current server"');
    const advanced = markup.indexOf('class="norea-settings-advanced"');
    expect(profileRow).toBeGreaterThan(-1);
    expect(verdictRow).toBeGreaterThan(profileRow);
    expect(advanced).toBeGreaterThan(verdictRow);
    expect(markup.slice(verdictRow, advanced)).toMatch(
      /class="norea-settings-inline-controls" data-compact="true"><p[^>]*class="[^"]*norea-settings-inline-value[^"]*"[^>]*>192\.0\.2\.10<\/p><span[^>]*class="norea-vpn-gate-verdict-control"/,
    );
  });
});
