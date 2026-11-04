import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { href: "/settings" } } }),
}));

import { SettingsPage } from "./settings";

function renderSettings(section?: string): string {
  return renderToStaticMarkup(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPage section={section} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

function detail(markup: string): string {
  const start = markup.indexOf('<section class="norea-settings-detail"');
  expect(start).toBeGreaterThanOrEqual(0);
  return markup.slice(start);
}

describe("settings sections", () => {
  it("lists every section in order with a current-state summary", () => {
    const markup = renderSettings();
    const order = [
      "Appearance",
      "General",
      "Reader",
      "Library",
      "Downloads &amp; storage",
      "Backup &amp; sync",
      "Network",
      "Data &amp; reset",
      "About",
      "Developer &amp; diagnostics",
    ].map((title) => markup.indexOf(`norea-list-item-title">${title}<`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(markup).toContain("Moss · System");
    expect(markup).not.toContain("Theme mode");
  });

  it("opens a section as its own page with Back instead of a section picker", () => {
    const markup = renderSettings("network");

    expect(markup).toContain('aria-label="Back"');
    expect(markup).toContain("Plugin VPN");
    expect(markup).not.toContain("norea-settings-index");
    expect(markup).not.toContain("Settings section");
    expect(markup).not.toContain("Tauri 2");
  });

  it("edits global reader defaults without the scope card", () => {
    const markup = renderSettings("reader");

    expect(markup).toContain("Reading mode");
    expect(markup).not.toContain("norea-reader-settings-scope-card");
    expect(markup).not.toContain("Editing global reader settings");
  });

  it("keeps the label switch in Appearance and drops the retired tab switches", () => {
    const markup = renderSettings("appearance");

    expect(markup).toContain("Navigation labels");
    for (const label of ["History tab", "Updates tab", "Cache tab", "Tasks tab"]) {
      expect(markup).not.toContain(label);
    }
  });

  it("picks the app theme from swatches and the UI scale as a percent", () => {
    const markup = detail(renderSettings("appearance"));

    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/role="radio"/g)).toHaveLength(9);
    expect(markup).toMatch(/aria-checked="true"[^>]*role="radio"[^]*?>Moss</);
    expect(markup).toContain("UI scale");
    expect(markup).toContain(">100%<");
    expect(markup).not.toContain("UI scale baseline");
  });

  it("no longer offers pause reading history in library settings", () => {
    const markup = renderSettings("library");

    expect(markup).toContain("Default library category");
    expect(markup).not.toContain("Pause reading history");
  });

  it.each([
    ["downloads", ["Storage folder", "Concurrent source work", "Per-source chapter download cooldown"], ["Source request timeout"]],
    ["backup", ["Backup file", "Content server"], ["Plugin VPN"]],
    ["network", ["Plugin VPN"], ["Backup file"]],
    ["reset", ["Clear library", "Clear reading progress", "Clear updates tab", "Appearance defaults", "Reader defaults"], ["Clear WebView cache"]],
    ["browse", ["Update extensions automatically"], ["Storage folder"]],
    ["about", ["Version", "Official release", "GitHub Releases"], ["Log level", "Dev build"]],
    ["developer", ["Log level", "Dev build", "Build time", "Custom User-Agent", "Clear WebView cache", "Source request timeout"], ["Official release"]],
  ])("places the %s settings in their section", (section, present, absent) => {
    const markup = detail(renderSettings(section));
    for (const label of present) expect(markup, label).toContain(label);
    for (const label of absent) expect(markup, label).not.toContain(label);
  });

  it("opens the renamed sections of earlier links", () => {
    expect(detail(renderSettings("data"))).toContain("Backup file");
    expect(detail(renderSettings("app"))).toContain("Theme mode");
  });
});
