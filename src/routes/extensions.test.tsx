import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Plugin, PluginItem } from "../lib/plugins/types";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => "/browse/extensions",
}));
vi.mock("../lib/plugins/manager", () => ({
  isPluginSourceInstanceOf: (pluginId: string, entry: PluginItem) =>
    entry.installMode === "multiSource" && pluginId.startsWith(`${entry.id}:`),
  isValidPluginItem: () => true,
  pluginManager: { list: () => [] },
}));

import {
  findDifferentPluginVersions,
  findPluginUpdates,
  updatePlugins,
} from "../components/browse/use-plugin-catalog";
import { AvailableSection, InstalledSection, UpdatesSection } from "./extensions";

function item(id: string, version = "1.0.0", extra: Partial<PluginItem> = {}): PluginItem {
  return {
    id, name: `Plugin ${id}`, lang: "en", version,
    url: `https://repo.example/${id}.js`, iconUrl: "", apiVersion: "0.2", ...extra,
  };
}

function plugin(id: string, version = "1.0.0", extra: Partial<Plugin> = {}): Plugin {
  return { ...item(id, version), getBaseUrl: () => `https://${id}.example`, ...extra } as Plugin;
}

function render(node: ReactNode) {
  return load(renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>));
}

const availableProps = {
  failures: [],
  filter: "",
  hasRepository: true,
  installingPluginIds: new Set<string>(),
  languages: ["en"],
  listedCount: 2,
  loading: false,
  locale: "en" as const,
  onClearFilters: vi.fn(),
  onFilterChange: vi.fn(),
  onInstall: vi.fn(),
  onLanguagesChange: vi.fn(),
  onRetry: vi.fn(),
  onSetRepository: vi.fn(),
  onSetUpSources: vi.fn(),
  selectedLanguages: [],
};

describe("Extensions available plugins", () => {
  it("shows install progress only on the plugin being installed", () => {
    const $ = render(
      <AvailableSection
        {...availableProps}
        entries={[
          { item: item("a"), repoUrl: "https://repo.example" },
          { item: item("b"), repoUrl: "https://repo.example" },
        ]}
        installableCount={2}
        installingPluginIds={new Set(["a"])}
      />,
    );

    expect($('button[aria-label="Install: Plugin a"]').attr("data-loading")).toBeDefined();
    expect($('button[aria-label="Install: Plugin b"]').attr("data-loading")).toBeUndefined();
    expect($('button[aria-label="Install: Plugin b"]').text()).toBe("Install");
  });

  it("labels a multi-source plugin with Add source instead of Install", () => {
    const $ = render(
      <AvailableSection
        {...availableProps}
        entries={[{ item: item("gh", "1.0.0", { installMode: "multiSource" }), repoUrl: "r" }]}
        installableCount={1}
      />,
    );

    expect($('button[aria-label="Add source: Plugin gh"]').text()).toBe("Add source");
  });

  it("offers to clear the filters when they hide every installable plugin", () => {
    const $ = render(
      <AvailableSection
        {...availableProps}
        entries={[]}
        installableCount={3}
        selectedLanguages={["ko"]}
      />,
    );

    expect($("body").text()).toContain("No plugin matches the name filter and the selected languages.");
    expect($("button").filter((_, button) => $(button).text() === "Clear filters")).toHaveLength(1);
  });

  it("offers the guided source setup when no repository is set", () => {
    const $ = render(
      <AvailableSection {...availableProps} entries={[]} hasRepository={false} installableCount={0} />,
    );

    expect($("button").filter((_, button) => $(button).text() === "Set up sources")).toHaveLength(1);
    expect($("button").filter((_, button) => $(button).text() === "Set repository")).toHaveLength(1);
  });

  it("does not show the repository URL or versions on multi-source rows", () => {
    const $ = render(
      <AvailableSection
        {...availableProps}
        entries={[{ item: item("gh", "9.9.9", { installMode: "multiSource" }), repoUrl: "https://repo.example/index.json" }]}
        installableCount={1}
      />,
    );

    expect($("body").text()).not.toContain("https://repo.example/index.json");
    expect($("body").text()).not.toContain("9.9.9");
  });
});

describe("Extensions installed plugins", () => {
  it("shows uninstall progress only on the plugin being uninstalled", () => {
    const $ = render(
      <InstalledSection
        differentVersions={new Map()}
        loading={false}
        locale="en"
        onOpenSettings={vi.fn()}
        onUninstall={vi.fn()}
        plugins={[plugin("a"), plugin("b")]}
        uninstallingPluginIds={new Set(["a"])}
      />,
    );

    expect($('[role="status"][aria-label="Uninstalling Plugin a"]')).toHaveLength(1);
    expect($('button[aria-label="Plugin a actions"]')).toHaveLength(0);
    expect($('button[aria-label="Plugin b actions"]')).toHaveLength(1);
    expect($("body").text()).toContain("English · 1.0.0");
  });

  it("marks the plugin opened from Manage in Extensions", () => {
    const $ = render(
      <InstalledSection
        differentVersions={new Map()}
        focusPluginId="b"
        loading={false}
        locale="en"
        onOpenSettings={vi.fn()}
        onUninstall={vi.fn()}
        plugins={[plugin("a"), plugin("b")]}
        uninstallingPluginIds={new Set()}
      />,
    );

    expect($("#norea-extension-b").attr("data-current")).toBe("true");
    expect($("#norea-extension-a").attr("data-current")).toBeUndefined();
  });
});

describe("Extensions updates", () => {
  it("lists only installed plugins whose repository version is strictly newer", () => {
    const updates = findPluginUpdates(
      [plugin("newer", "1.2.0"), plugin("same", "2.0.0"), plugin("older", "3.1.0"), plugin("odd", "1.0.0")],
      [
        { item: item("newer", "1.10.0"), repoUrl: "r" },
        { item: item("same", "2.0"), repoUrl: "r" },
        { item: item("older", "3.0.9"), repoUrl: "r" },
        { item: item("odd", "next"), repoUrl: "r" },
        { item: item("missing", "9.0.0"), repoUrl: "r" },
      ],
    );

    expect(updates.map(({ plugin: installed }) => installed.id)).toEqual(["newer"]);
  });

  it("updates source instances from their multi-source template", () => {
    const template = item("github", "2.0.0", { installMode: "multiSource" });
    const updates = findPluginUpdates(
      [plugin("github:owner-shelf", "1.0.0"), plugin("github:other", "2.0.0"), plugin("github", "1.0.0")],
      [{ item: template, repoUrl: "r" }],
    );

    expect(updates.map(({ plugin: installed }) => installed.id)).toEqual(["github:owner-shelf"]);
    expect(updates[0]?.item).toBe(template);
  });

  it("reports lower or unorderable repository versions apart from updates", () => {
    const different = findDifferentPluginVersions(
      [plugin("older", "3.1.0"), plugin("odd", "1.0.0"), plugin("newer", "1.0.0")],
      [
        { item: item("older", "3.0.9"), repoUrl: "r" },
        { item: item("odd", "next"), repoUrl: "r" },
        { item: item("newer", "1.1.0"), repoUrl: "r" },
      ],
    );

    expect(different.map(({ plugin: installed }) => installed.id)).toEqual(["older", "odd"]);
    const $ = render(
      <InstalledSection
        differentVersions={new Map([["older", "3.0.9"]])}
        loading={false}
        locale="en"
        onOpenSettings={vi.fn()}
        onUninstall={vi.fn()}
        plugins={[plugin("older", "3.1.0")]}
        uninstallingPluginIds={new Set()}
      />,
    );
    expect($("#norea-extension-older").text()).toContain("Different version available (3.0.9)");
  });

  it("offers Update all for several updates and marks every pending row", () => {
    const $ = render(
      <UpdatesSection
        failedUpdates={new Map()}
        onUpdate={vi.fn()}
        onUpdateAll={vi.fn()}
        updatingPluginIds={new Set(["a"])}
        updates={[
          { item: item("a", "1.1.0"), plugin: plugin("a", "1.0.0") },
          { item: item("b", "2.1.0"), plugin: plugin("b", "2.0.0") },
        ]}
      />,
    );

    expect($('button[aria-label="Update Plugin a"]').attr("data-loading")).toBeDefined();
    expect($('button[aria-label="Update Plugin b"]').attr("data-loading")).toBeUndefined();
    expect($("body").text()).toContain("2.0.0 → 2.1.0");
    expect($("button:contains('Update all')")).toHaveLength(1);
  });

  it("leaves a single update to its row button", () => {
    const $ = render(
      <UpdatesSection
        failedUpdates={new Map()}
        onUpdate={vi.fn()}
        onUpdateAll={vi.fn()}
        updatingPluginIds={new Set()}
        updates={[{ item: item("a", "1.1.0"), plugin: plugin("a", "1.0.0") }]}
      />,
    );

    expect($("body").text()).not.toContain("Update all");
  });

  it("reports a failed update on its row and keeps it retryable", () => {
    const $ = render(
      <UpdatesSection
        failedUpdates={new Map([["b", new Error("offline")]])}
        onUpdate={vi.fn()}
        onUpdateAll={vi.fn()}
        updatingPluginIds={new Set()}
        updates={[
          { item: item("a", "1.1.0"), plugin: plugin("a", "1.0.0") },
          { item: item("b", "2.1.0"), plugin: plugin("b", "2.0.0") },
        ]}
      />,
    );

    expect($("body").text()).toContain("2.0.0 → 2.1.0 · Update failed");
    expect($('button[aria-label="Update Plugin b"]').text()).toBe("Retry");
    expect($("body").text()).toContain("Couldn't update 1 extensions");
    expect($("body").text()).toContain("Plugin b: offline");
  });

  it("keeps updating the others after one plugin fails", async () => {
    const order: string[] = [];
    const outcomes = await updatePlugins(
      [
        { item: item("a", "1.1.0"), plugin: plugin("a") },
        { item: item("b", "1.1.0"), plugin: plugin("b") },
        { item: item("c", "1.1.0"), plugin: plugin("c") },
      ],
      async ({ plugin: target }) => {
        order.push(target.id);
        if (target.id === "b") throw new Error("broken source");
      },
    );

    expect(order).toEqual(["a", "b", "c"]);
    expect(outcomes.map(({ error, plugin: target }) => [target.id, error ? String(error) : null])).toEqual([
      ["a", null],
      ["b", "Error: broken source"],
      ["c", null],
    ]);
  });
});
