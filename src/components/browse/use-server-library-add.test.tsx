import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkSummary } from "../../lib/content-sync/browse";
import type { ServerLibraryAddResult } from "./server-library-add";

const mocks = vi.hoisted(() => ({
  downloadAll: vi.fn(),
  enqueue: vi.fn(),
  hide: vi.fn(),
  invalidate: vi.fn(),
  show: vi.fn(),
  state: [] as unknown[],
  stateIndex: 0,
}));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.state)) mocks.state[index] = initial;
    return [mocks.state[index], (next: unknown) => {
      mocks.state[index] = typeof next === "function" ? next(mocks.state[index]) : next;
    }];
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], error: null, isPending: false }),
  useQueryClient: () => queryClient,
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t }) }));
vi.mock("./server-download-all", () => ({ downloadServerWorksOnce: mocks.downloadAll }));
vi.mock("@mantine/notifications", () => ({ notifications: { hide: mocks.hide, show: mocks.show } }));
vi.mock("./server-library-add", async original => ({
  ...await original<typeof import("./server-library-add")>(),
  enqueueServerLibraryAdd: mocks.enqueue,
}));

import { ServerLibraryAddError } from "./server-library-add";
import { startServerLibraryAdd, useServerLibraryAdd } from "./use-server-library-add";

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
  mocks.state.length = 0;
});

const renderHook = () => {
  mocks.stateIndex = 0;
  return useServerLibraryAdd("http://server");
};
function confirmButton(node: ReactNode): ReactElement<{ onClick: () => void }> | undefined {
  if (Array.isArray(node)) return node.map(confirmButton).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; footer?: ReactNode; onClick?: () => void }>(node)) return undefined;
  if (node.props.children === "quickAdd.add" && node.props.onClick) return node as ReactElement<{ onClick: () => void }>;
  return confirmButton(node.props.footer) ?? confirmButton(node.props.children);
}

it("queues the prompted works' chapters with the confirmed add's task promise", () => {
  const promise = new Promise(() => undefined);
  mocks.enqueue.mockReturnValue({ id: "task", promise });
  const onStarted = vi.fn();
  renderHook().request({ count: 1, downloadChaptersOf: [work("a"), work("b")], onStarted, works: [work("a")] });
  confirmButton(renderHook().sheet)!.props.onClick();
  expect(mocks.enqueue).toHaveBeenCalledWith({ categoryIds: [], count: 1, server: "http://server", works: [work("a")] }, t, expect.any(Function));
  expect(mocks.downloadAll).toHaveBeenCalledWith([work("a"), work("b")], promise, t, queryClient, "http://server");
  expect(onStarted).toHaveBeenCalled();
});

it("only adds when the prompt names no works to download", () => {
  mocks.enqueue.mockReturnValue({ id: "task", promise: new Promise(() => undefined) });
  renderHook().request({ count: 1, works: [work("a")] });
  confirmButton(renderHook().sheet)!.props.onClick();
  expect(mocks.enqueue).toHaveBeenCalled();
  expect(mocks.downloadAll).not.toHaveBeenCalled();
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
