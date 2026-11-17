import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { listUserWorkCategories } from "./user-state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => { vi.clearAllMocks(); });

it("reads work categories in committed batches of 200 works", async () => {
  const works = Array.from({ length: 201 }, (_, index) => ({ pluginId: "plugin", novelId: String(index), novelPath: `/${index}` }));
  mockedInvoke.mockImplementation(async (_command, args) =>
    (args as { works: typeof works }).works.map(work => ({ pluginId: work.pluginId, novelPath: work.novelPath, categories: [] })));
  const result = await listUserWorkCategories("http://server", works);
  expect(result).toHaveLength(201);
  expect(mockedInvoke.mock.calls.map(([command, args]) => [command, (args as { works: unknown[]; mode: string; serverUrl: string }).works.length,
    (args as { mode: string }).mode, (args as { serverUrl: string }).serverUrl])).toEqual([
    ["db_user_state_list_work_categories", 200, "committed", "http://server"],
    ["db_user_state_list_work_categories", 1, "committed", "http://server"],
  ]);
});
