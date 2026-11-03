import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Plugin, PluginItem } from "../lib/plugins/types";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../lib/plugins/manager", () => ({
  isValidPluginItem: () => true,
  pluginManager: { list: () => [] },
}));

import { AvailableSection, InstalledSection } from "./browse";

function item(id: string): PluginItem {
  return {
    id, name: `Plugin ${id}`, lang: "en", version: "1.0.0",
    url: `https://repo.example/${id}.js`, iconUrl: "", apiVersion: "0.2",
  };
}

function plugin(id: string): Plugin {
  return { ...item(id), getBaseUrl: () => `https://${id}.example` } as Plugin;
}

function buttonState(markup: string, label: string): { disabled: boolean; loading: boolean } {
  const $ = load(markup);
  const button = $(`button[aria-label="${label}"]`);
  expect(button.length).toBe(1);
  return {
    disabled: button.attr("disabled") !== undefined,
    loading: button.attr("data-loading") !== undefined,
  };
}

describe("browse per-row pending state", () => {
  it("shows install progress only on the plugin being installed", () => {
    const query = {
      isLoading: false, isFetching: false, error: null,
      data: { entries: [], failures: [] },
    } as unknown as ComponentProps<typeof AvailableSection>["query"];
    const markup = renderToStaticMarkup(
      <MantineProvider>
        <AvailableSection
          query={query}
          entries={[
            { item: item("a"), repoUrl: "https://repo.example" },
            { item: item("b"), repoUrl: "https://repo.example" },
          ]}
          locale="en"
          hasRepository
          installedPluginsById={new Map()}
          onInstall={vi.fn()}
          installingPluginIds={new Set(["a"])}
          failures={[]}
        />
      </MantineProvider>,
    );

    expect(buttonState(markup, "Install: Plugin a")).toEqual({ disabled: true, loading: true });
    expect(buttonState(markup, "Install: Plugin b")).toEqual({ disabled: false, loading: false });
  });

  it("shows uninstall progress only on the plugin being uninstalled", () => {
    const markup = renderToStaticMarkup(
      <MantineProvider>
        <InstalledSection
          plugins={[plugin("a"), plugin("b")]}
          locale="en"
          canClearCookies={false}
          clearingCookiePluginId={null}
          onUninstall={vi.fn()}
          uninstallingPluginIds={new Set(["a"])}
          lastUsedPluginId={null}
          onClearCookies={vi.fn()}
          onOpenSource={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </MantineProvider>,
    );

    expect(buttonState(markup, "Uninstall: Plugin a")).toEqual({ disabled: true, loading: true });
    expect(buttonState(markup, "Uninstall: Plugin b")).toEqual({ disabled: false, loading: false });
    expect(buttonState(markup, "Source: Plugin b").disabled).toBe(false);
  });
});
