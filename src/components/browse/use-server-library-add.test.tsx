import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkSummary } from "../../lib/content-sync/browse";
import type { ServerLibraryAddResult } from "./server-library-add";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  hide: vi.fn(),
  invalidate: vi.fn(),
  show: vi.fn(),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { hide: mocks.hide, show: mocks.show } }));
vi.mock("./server-library-add", async original => ({
  ...await original<typeof import("./server-library-add")>(),
  enqueueServerLibraryAdd: mocks.enqueue,
}));

import { ServerLibraryAddError } from "./server-library-add";
import { startServerLibraryAdd } from "./use-server-library-add";

const work = (id: string) => ({ id, novel: { name: `Book ${id}` }, identity: { pluginId: "source", novelPath: `/${id}` } }) as ServerWorkSummary;
const t = (key: string, values?: Record<string, string | number>) => values?.count !== undefined ? `${key}:${values.count}` : key;
const queryClient = { invalidateQueries: mocks.invalidate } as never;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function retryButton(call: number): ReactElement<{ onClick: () => void }> {
  const find = (node: ReactNode): ReactElement<{ onClick: () => void }> | undefined => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return undefined;
    if (node.props.children === "common.retry" && node.props.onClick) return node as ReactElement<{ onClick: () => void }>;
    return find(node.props.children);
  };
  return find(mocks.show.mock.calls[call]![0].message)!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("toasts the summary once the background add finishes and refreshes library queries", async () => {
  const result: ServerLibraryAddResult = { added: 118, failed: [], pending: [], skipped: 2 };
  mocks.enqueue.mockReturnValue({ id: "task", promise: Promise.resolve(result) });
  startServerLibraryAdd({ categoryIds: [3], count: 120, server: "http://server", works: { query: "", source: "" } }, t, queryClient);
  await settle();
  expect(mocks.enqueue).toHaveBeenCalledWith(
    { categoryIds: [3], count: 120, server: "http://server", works: { query: "", source: "" } }, t, expect.any(Function));
  expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({
    color: "ok", message: "serverLibraryAdd.added:118 · serverLibraryAdd.skipped:2",
  }));
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["novel"] });
});

it("lists failed works with a Retry that adds only those works again", async () => {
  const failed = [{ error: "offline", work: work("b") }, { error: "offline", work: work("c") }];
  const error = new ServerLibraryAddError("partial", { added: 118, failed, pending: [], skipped: 0 });
  mocks.enqueue
    .mockReturnValueOnce({ id: "task", promise: Promise.reject(error) })
    .mockReturnValue({ id: "retry", promise: new Promise(() => undefined) });
  startServerLibraryAdd({ categoryIds: [], count: 120, server: "http://server", works: { query: "", source: "" } }, t, queryClient);
  await settle();
  expect(mocks.show.mock.calls[0]![0]).toMatchObject({
    color: "danger", title: "serverLibraryAdd.added:118 · serverLibraryAdd.failedCount:2",
  });

  retryButton(0).props.onClick();
  expect(mocks.enqueue).toHaveBeenLastCalledWith(
    { categoryIds: [], count: 2, server: "http://server", works: [work("b"), work("c")] }, t, expect.any(Function));
});

it("stays quiet when the user cancels the task", async () => {
  mocks.enqueue.mockReturnValue({ id: "task", promise: Promise.reject(new DOMException("Task was cancelled.", "AbortError")) });
  startServerLibraryAdd({ categoryIds: [], count: 3, server: "http://server", works: [work("a")] }, t, queryClient);
  await settle();
  expect(mocks.show).not.toHaveBeenCalled();
});
