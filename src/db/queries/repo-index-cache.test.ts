import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { PluginItem } from "../../lib/plugins/types";
import { createTauriInvokeRouter } from "../../test/mock-tauri-invoke";
import {
  deleteCachedRepoIndex,
  getCachedRepoIndex,
  listAllCachedRepoIndexes,
  setCachedRepoIndex,
} from "./repo-index-cache";

const invokeMock = vi.mocked(invoke);
const router = createTauriInvokeRouter();

const sampleItem: PluginItem = {
  id: "demo",
  name: "Demo",
  lang: "ko",
  version: "1.0.0",
  url: "https://repo.example/demo.js",
  iconUrl: "https://repo.example/demo.png",
  apiVersion: "0.2",
};

beforeEach(() => {
  vi.clearAllMocks();
  router.reset();
  router.installOn(invokeMock);
});

describe("repo-index-cache queries", () => {
  it("reads single and all cached repository indexes", async () => {
    router.mockQuery("db_repo_cache_get", null);
    router.mockQuery("db_repo_cache_list_all", [
      {
        repoUrl: "https://repo.example/index.json",
        fetchedAt: 1234,
        items: [sampleItem],
      },
    ]);

    await expect(
      getCachedRepoIndex("https://missing.example/index.json"),
    ).resolves.toBeNull();
    const all = await listAllCachedRepoIndexes();

    expect(all).toEqual([
      {
        repoUrl: "https://repo.example/index.json",
        fetchedAt: 1234,
        items: [sampleItem],
      },
    ]);
    expect(router.calls).toEqual([
      {
        command: "db_repo_cache_get",
        args: { repoUrl: "https://missing.example/index.json" },
        options: undefined,
      },
      {
        command: "db_repo_cache_list_all",
        args: undefined,
        options: undefined,
      },
    ]);
  });

  it("writes and deletes cached repository indexes", async () => {
    router.mockMutation("db_repo_cache_set");
    router.mockMutation("db_repo_cache_delete");

    await setCachedRepoIndex("https://repo.example/index.json", [sampleItem]);
    await deleteCachedRepoIndex("https://repo.example/index.json");

    expect(router.calls).toEqual([
      {
        command: "db_repo_cache_set",
        args: {
          repoUrl: "https://repo.example/index.json",
          items: [sampleItem],
        },
        options: undefined,
      },
      {
        command: "db_repo_cache_delete",
        args: { repoUrl: "https://repo.example/index.json" },
        options: undefined,
      },
    ]);
  });
});
