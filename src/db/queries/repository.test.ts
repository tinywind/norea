import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { createTauriInvokeRouter } from "../../test/mock-tauri-invoke";
import {
  addRepository,
  listRepositories,
  removeRepository,
  reorderRepositories,
  setRepositoryEnabled,
} from "./repository";

const invokeMock = vi.mocked(invoke);
const router = createTauriInvokeRouter();

beforeEach(() => {
  vi.clearAllMocks();
  router.reset();
  router.installOn(invokeMock);
});

describe("listRepositories", () => {
  it("returns every repository from db_repo_list", async () => {
    router.mockQuery("db_repo_list", [
      {
        id: 2,
        url: "https://b.test/index.json",
        name: null,
        addedAt: 200,
        priority: 1,
        enabled: false,
      },
      {
        id: 1,
        url: "https://a.test/index.json",
        name: "Alpha",
        addedAt: 100,
        priority: 2,
        enabled: true,
      },
    ]);

    const rows = await listRepositories();

    expect(router.calls).toEqual([
      { command: "db_repo_list", args: undefined, options: undefined },
    ]);
    expect(rows.map(({ id, enabled }) => [id, enabled])).toEqual([
      [2, false],
      [1, true],
    ]);
  });
});

describe("addRepository", () => {
  it("forwards normalized input to db_repo_add and returns insertion flag", async () => {
    router.mockMutation("db_repo_add", true);

    await expect(
      addRepository({ url: "https://example.test/p.json", name: "Demo" }),
    ).resolves.toBe(true);

    expect(router.calls[0]).toEqual({
      command: "db_repo_add",
      args: { input: { url: "https://example.test/p.json", name: "Demo" } },
      options: undefined,
    });
  });

  it("normalizes omitted repository name to null and reports duplicates", async () => {
    router.mockMutation("db_repo_add", false);

    await expect(
      addRepository({ url: "https://example.test/p.json" }),
    ).resolves.toBe(false);
    expect(router.calls[0]).toEqual({
      command: "db_repo_add",
      args: { input: { url: "https://example.test/p.json", name: null } },
      options: undefined,
    });
  });
});

describe("repository order and enabled state", () => {
  it("sends boolean enabled state to db_repo_set_enabled", async () => {
    router.mockMutation("db_repo_set_enabled");

    await setRepositoryEnabled(3, false);

    expect(router.calls[0]).toEqual({
      command: "db_repo_set_enabled",
      args: { id: 3, enabled: false },
      options: undefined,
    });
  });

  it("skips IPC on empty reorder and sends orderedIds otherwise", async () => {
    router.mockMutation("db_repo_reorder");

    await reorderRepositories([]);
    expect(router.calls).toHaveLength(0);

    await reorderRepositories([5, 2, 9]);
    expect(router.calls).toEqual([
      {
        command: "db_repo_reorder",
        args: { orderedIds: [5, 2, 9] },
        options: undefined,
      },
    ]);
  });
});

describe("removeRepository", () => {
  it("delegates atomic cache and repository deletion to db_repo_remove", async () => {
    router.mockMutation("db_repo_remove");

    await removeRepository(42);

    expect(router.calls).toEqual([
      {
        command: "db_repo_remove",
        args: { id: 42 },
        options: undefined,
      },
    ]);
  });
});
