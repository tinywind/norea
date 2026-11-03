import { describe, expect, it } from "vitest";
import { normalizeFirstRunSetupState } from "../store/setup";
import {
  initialSetupLanguages,
  setupLanguages,
  shouldOpenFirstRunSetup,
  suggestedSetupSources,
} from "./first-run-setup";
import type { PluginItem } from "./plugins/types";

const item = (id: string, lang: string, extra: Partial<PluginItem> = {}) =>
  ({ id, lang, name: `Source ${id}`, site: "https://example.test", url: `https://repo.test/${id}.js`, version: "1.0.0", ...extra }) as PluginItem;

const items = [item("b", "en"), item("a", "en"), item("k", "ko"), item("j", "ja"), item("t", "en", { installMode: "multiSource" })];

describe("shouldOpenFirstRunSetup", () => {
  const base = { pathname: "/", pluginCount: 0, repositoryCount: 0, setupState: null } as const;

  it("opens on a Library launch with no repository, no plugin and no recorded setup", () => {
    expect(shouldOpenFirstRunSetup(base)).toBe(true);
  });

  it.each([
    ["finished", { setupState: "done" as const }],
    ["skipped", { setupState: "skipped" as const }],
    ["a repository exists", { repositoryCount: 1 }],
    ["a plugin exists", { pluginCount: 2 }],
    ["the launch opened another page", { pathname: "/reader" }],
  ])("stays closed when %s", (_, change) => {
    expect(shouldOpenFirstRunSetup({ ...base, ...change })).toBe(false);
  });
});

describe("setup suggestions", () => {
  it("lists the repository's languages with the app language first", () => {
    expect(setupLanguages(items, "ko")).toEqual(["ko", "en", "ja"]);
    expect(setupLanguages(items, "de")).toEqual(["en", "ja", "ko"]);
  });

  it("preselects the app language only when the repository has sources in it", () => {
    expect(initialSetupLanguages(items, "en")).toEqual(["en"]);
    expect(initialSetupLanguages(items, "de")).toEqual([]);
  });

  it("suggests one-step sources in the chosen languages, by name", () => {
    expect(suggestedSetupSources(items, ["en"]).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(suggestedSetupSources(items, ["en", "ko"]).map((entry) => entry.id)).toEqual(["a", "b", "k"]);
  });

  it("keeps only a finished or skipped setup state from storage", () => {
    expect(normalizeFirstRunSetupState("done")).toBe("done");
    expect(normalizeFirstRunSetupState("skipped")).toBe("skipped");
    expect(normalizeFirstRunSetupState("later")).toBeNull();
    expect(normalizeFirstRunSetupState(undefined)).toBeNull();
  });
});
