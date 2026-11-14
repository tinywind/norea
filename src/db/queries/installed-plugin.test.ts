import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { createTauriInvokeRouter } from "../../test/mock-tauri-invoke";
import {
  deleteInstalledPlugin,
  listInstalledPlugins,
  upsertInstalledPlugin,
} from "./installed-plugin";

const invokeMock = vi.mocked(invoke);
const router = createTauriInvokeRouter();

beforeEach(() => {
  vi.clearAllMocks();
  router.reset();
  router.installOn(invokeMock);
});

describe("installed-plugin queries", () => {
  it("lists installed plugins via db_plugin_list_installed", async () => {
    router.mockQuery("db_plugin_list_installed", [
      {
        id: "demo",
        name: "Demo Source",
        lang: "ko",
        version: "1.0.0",
        iconUrl: "https://example.test/icon.png",
        sourceUrl: "https://example.test/demo.js",
        sourceCode: "module.exports = {};",
        installedAt: 1700000000,
        repositoryUrl: "https://example.test/index.json",
      },
    ]);

    const rows = await listInstalledPlugins();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("demo");
    expect(router.calls).toEqual([
      {
        command: "db_plugin_list_installed",
        args: undefined,
        options: undefined,
      },
    ]);
  });

  it("upserts and deletes installed plugins via Rust commands", async () => {
    router.mockMutation("db_plugin_upsert_installed");
    router.mockMutation("db_plugin_delete_installed");

    const input = {
      id: "demo",
      name: "Demo Source",
      lang: "ko",
      version: "1.1.0",
      iconUrl: "https://example.test/icon.png",
      sourceUrl: "https://example.test/demo.js",
      sourceCode: "module.exports = {};",
      repositoryUrl: null,
    };
    await upsertInstalledPlugin(input);
    await deleteInstalledPlugin("demo");

    expect(router.calls).toEqual([
      {
        command: "db_plugin_upsert_installed",
        args: { input },
        options: undefined,
      },
      {
        command: "db_plugin_delete_installed",
        args: { id: "demo" },
        options: undefined,
      },
    ]);
  });
});
