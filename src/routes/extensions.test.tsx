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
  findPublisherOffers,
  mergeCatalogEntries,
  updatePlugins,
  type AvailableEntry,
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
  enabledRepositoryCount: 1,
  failures: [],
  filter: "",
  onOpenRepositories: vi.fn(),
  repositoryCount: 1,
  repositoryLabels: new Map<string, string>(),
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

    expect($('button[aria-label="Install Plugin a"]').attr("data-loading")).toBeDefined();
    expect($('button[aria-label="Install Plugin b"]').attr("data-loading")).toBeUndefined();
    expect($('button[aria-label="Install Plugin b"] .tabler-icon-download')).toHaveLength(1);
  });

  it("labels a multi-source plugin with Add source instead of Install", () => {
    const $ = render(
      <AvailableSection
        {...availableProps}
        entries={[{ item: item("gh", "1.0.0", { installMode: "multiSource" }), repoUrl: "r" }]}
        installableCount={1}
      />,
    );

    expect($('button[aria-label="Add Plugin gh source"] .tabler-icon-plus')).toHaveLength(1);
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
      <AvailableSection
        {...availableProps}
        enabledRepositoryCount={0}
        entries={[]}
        installableCount={0}
        repositoryCount={0}
      />,
    );

    expect($("button").filter((_, button) => $(button).text() === "Set up sources")).toHaveLength(1);
    expect($("button").filter((_, button) => $(button).text() === "Add repository")).toHaveLength(1);
  });

  it("points to the repository list when every repository is turned off", () => {
    const $ = render(
      <AvailableSection
        {...availableProps}
        enabledRepositoryCount={0}
        entries={[]}
        installableCount={0}
        repositoryCount={2}
      />,
    );

    expect($("body").text()).toContain("Every repository is turned off.");
    expect($("button").filter((_, button) => $(button).text() === "Repositories")).toHaveLength(1);
  });

  it("names the repository on each row only when several are turned on", () => {
    const entries = [{ item: item("a"), repoUrl: "https://two.example/index.json" }];
    const labels = new Map([["https://two.example/index.json", "owner/two"]]);
    const single = render(
      <AvailableSection {...availableProps} entries={entries} installableCount={1} repositoryLabels={labels} />,
    );
    const several = render(
      <AvailableSection
        {...availableProps}
        enabledRepositoryCount={2}
        entries={entries}
        installableCount={1}
        repositoryCount={2}
        repositoryLabels={labels}
      />,
    );

    expect(single("body").text()).not.toContain("owner/two");
    expect(several("body").text()).toContain("English · 1.0.0 · owner/two");
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

const installedProps = {
  onOpenSettings: vi.fn(),
  onSwitchPublisher: vi.fn(),
  onUninstall: vi.fn(),
  publisherOf: (): string | null => "r",
  publisherOffers: new Map<string, AvailableEntry[]>(),
  repositoryLabels: new Map([["r", "first"], ["s", "second"]]),
  switchingPluginIds: new Set<string>(),
};

describe("Extensions installed plugins", () => {
  it("shows uninstall progress only on the plugin being uninstalled", () => {
    const $ = render(
      <InstalledSection
        differentVersions={new Map()}
        loading={false}
        locale="en"
        {...installedProps}
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
        {...installedProps}
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
      () => "r",
    );

    expect(updates.map(({ plugin: installed }) => installed.id)).toEqual(["newer"]);
  });

  it("updates source instances from their multi-source template", () => {
    const template = item("github", "2.0.0", { installMode: "multiSource" });
    const updates = findPluginUpdates(
      [plugin("github:owner-shelf", "1.0.0"), plugin("github:other", "2.0.0"), plugin("github", "1.0.0")],
      [{ item: template, repoUrl: "r" }],
      () => "r",
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
      () => "r",
    );

    expect(different.map(({ plugin: installed }) => installed.id)).toEqual(["older", "odd"]);
    const $ = render(
      <InstalledSection
        differentVersions={new Map([["older", "3.0.9"]])}
        loading={false}
        locale="en"
        {...installedProps}
        plugins={[plugin("older", "3.1.0")]}
        uninstallingPluginIds={new Set()}
      />,
    );
    expect($("#norea-extension-older").text()).toContain("Different version available (3.0.9)");
  });

  it("updates a plugin only from its publishing repository", () => {
    const publishers: Record<string, string | null> = { first: "r", second: "s", unknown: null };
    const updates = findPluginUpdates(
      [plugin("first", "1.0.0"), plugin("second", "1.0.0"), plugin("unknown", "1.0.0")],
      [
        { item: item("first", "1.0.0"), repoUrl: "r" },
        { item: item("second", "5.0.0"), repoUrl: "r" },
        { item: item("first", "2.0.0"), repoUrl: "s" },
        { item: item("second", "1.5.0"), repoUrl: "s" },
        { item: item("unknown", "9.0.0"), repoUrl: "r" },
      ],
      (id) => publishers[id] ?? null,
    );

    expect(updates.map(({ plugin: installed, item: entry, repoUrl }) => [installed.id, entry.version, repoUrl]))
      .toEqual([["second", "1.5.0", "s"]]);
  });

  it("lists other repositories offering a plugin, and every offer for an unknown publisher", () => {
    const template = item("github", "2.0.0", { installMode: "multiSource" });
    const offers = findPublisherOffers(
      [plugin("known", "1.0.0"), plugin("unknown", "1.0.0"), plugin("github:shelf", "1.0.0")],
      [
        { item: item("known", "1.0.0"), repoUrl: "r" },
        { item: item("known", "1.2.0"), repoUrl: "s" },
        { item: item("unknown", "1.0.0"), repoUrl: "r" },
        { item: item("unknown", "1.0.0"), repoUrl: "s" },
        { item: template, repoUrl: "s" },
      ],
      (id) => (id === "unknown" ? null : "r"),
    );

    expect([...offers].map(([id, list]) => [id, list.map(({ repoUrl }) => repoUrl)])).toEqual([
      ["known", ["s"]],
      ["unknown", ["r", "s"]],
      ["github:shelf", ["s"]],
    ]);
  });

  it("keeps the highest-priority repository's entry for a plugin listed twice", () => {
    const merged = mergeCatalogEntries([
      { item: item("a", "1.0.0"), repoUrl: "r" },
      { item: item("b", "1.0.0"), repoUrl: "r" },
      { item: item("a", "3.0.0"), repoUrl: "s" },
      { item: item("c", "1.0.0"), repoUrl: "s" },
    ]);

    expect(merged.map(({ item: entry, repoUrl }) => [entry.id, entry.version, repoUrl]))
      .toEqual([["a", "1.0.0", "r"], ["b", "1.0.0", "r"], ["c", "1.0.0", "s"]]);
  });

  it("asks for a publisher and shows newer offers from other repositories", () => {
    const $ = render(
      <InstalledSection
        {...installedProps}
        differentVersions={new Map()}
        loading={false}
        locale="en"
        plugins={[plugin("known", "1.0.0"), plugin("unknown", "1.0.0")]}
        publisherOf={(id) => (id === "unknown" ? null : "r")}
        publisherOffers={new Map([
          ["known", [{ item: item("known", "1.4.0"), repoUrl: "s" }]],
          ["unknown", [{ item: item("unknown", "1.0.0"), repoUrl: "r" }]],
        ])}
        uninstallingPluginIds={new Set()}
      />,
    );

    expect($("#norea-extension-known").text()).toContain("Also available from second (1.4.0)");
    expect($("#norea-extension-known").text()).not.toContain("Choose publisher");
    expect($("#norea-extension-unknown").text()).toContain("Unknown publisher");
    expect($('button[aria-label="Choose publisher: Plugin unknown"]')).toHaveLength(1);
  });

  it("offers Update all for several updates and marks every pending row", () => {
    const $ = render(
      <UpdatesSection
        failedUpdates={new Map()}
        onUpdate={vi.fn()}
        onUpdateAll={vi.fn()}
        updatingPluginIds={new Set(["a"])}
        updates={[
          { item: item("a", "1.1.0"), plugin: plugin("a", "1.0.0"), repoUrl: "r" },
          { item: item("b", "2.1.0"), plugin: plugin("b", "2.0.0"), repoUrl: "r" },
        ]}
      />,
    );

    expect($('button[aria-label="Update Plugin a"]').attr("data-loading")).toBeDefined();
    expect($('button[aria-label="Update Plugin b"]').attr("data-loading")).toBeUndefined();
    expect($("body").text()).toContain("2.0.0 → 2.1.0");
    expect($('button[aria-label="Update all 2 plugins"]')).toHaveLength(1);
    expect($(".mantine-Indicator-indicator").text()).toBe("2");
  });

  it("leaves a single update to its row button", () => {
    const $ = render(
      <UpdatesSection
        failedUpdates={new Map()}
        onUpdate={vi.fn()}
        onUpdateAll={vi.fn()}
        updatingPluginIds={new Set()}
        updates={[{ item: item("a", "1.1.0"), plugin: plugin("a", "1.0.0"), repoUrl: "r" }]}
      />,
    );

    expect($('button[aria-label^="Update all"]')).toHaveLength(0);
  });

  it("reports a failed update on its row and keeps it retryable", () => {
    const $ = render(
      <UpdatesSection
        failedUpdates={new Map([["b", new Error("offline")]])}
        onUpdate={vi.fn()}
        onUpdateAll={vi.fn()}
        updatingPluginIds={new Set()}
        updates={[
          { item: item("a", "1.1.0"), plugin: plugin("a", "1.0.0"), repoUrl: "r" },
          { item: item("b", "2.1.0"), plugin: plugin("b", "2.0.0"), repoUrl: "r" },
        ]}
      />,
    );

    expect($("body").text()).toContain("2.0.0 → 2.1.0 · Update failed");
    expect($('button[aria-label="Update Plugin a"] .tabler-icon-download')).toHaveLength(1);
    expect($('button[aria-label="Update Plugin b"] .tabler-icon-reload')).toHaveLength(1);
    expect($("body").text()).toContain("Couldn't update 1 extensions");
    expect($("body").text()).toContain("Plugin b: offline");
  });

  it("keeps updating the others after one plugin fails", async () => {
    const order: string[] = [];
    const outcomes = await updatePlugins(
      [
        { item: item("a", "1.1.0"), plugin: plugin("a"), repoUrl: "r" },
        { item: item("b", "1.1.0"), plugin: plugin("b"), repoUrl: "r" },
        { item: item("c", "1.1.0"), plugin: plugin("c"), repoUrl: "r" },
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
