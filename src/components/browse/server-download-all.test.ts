import { beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkSummary } from "../../lib/content-sync/browse";

const mocks = vi.hoisted(() => ({
  errorToast: vi.fn(),
  findNovel: vi.fn(),
  inLibrary: new Map<string, number>(),
  notice: vi.fn((_t: unknown, outcome: { queued: number }) => ({ color: "ok", message: `queued:${outcome.queued}` })),
  queue: vi.fn(async (_ids: readonly number[]) => ({ queued: 7, skippedLocal: 0 })),
  show: vi.fn(),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.show } }));
vi.mock("../../db/queries/novel", () => ({ findNovelBySource: mocks.findNovel }));
vi.mock("../../lib/runtime/error-toast", () => ({ showErrorToast: mocks.errorToast }));
vi.mock("../library/download-once", () => ({ downloadOnceNotice: mocks.notice, queueChapterDownloadsOnce: mocks.queue }));

import { downloadServerWorksOnce } from "./server-download-all";
import { ServerLibraryAddError } from "./server-library-add";

const work = (id: string) => ({ id, novel: { name: id }, identity: { pluginId: "source", novelPath: `/${id}` } }) as ServerWorkSummary;
const t = (key: string, values?: Record<string, string | number>) => values?.count !== undefined ? `${key}:${values.count}` : key;
const queryClient = { invalidateQueries: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inLibrary.clear();
  mocks.findNovel.mockImplementation(async (_pluginId: string, path: string) => {
    const id = mocks.inLibrary.get(path);
    return id === undefined ? null : { id, inLibrary: true };
  });
});

it("queues chapters of new and existing works only after the library add settles", async () => {
  mocks.inLibrary.set("/existing", 1);
  let finishAdd!: () => void;
  const add = new Promise<void>((resolve) => { finishAdd = resolve; });
  const done = downloadServerWorksOnce([work("existing"), work("new")], add, t, queryClient);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mocks.findNovel).not.toHaveBeenCalled();
  expect(mocks.queue).not.toHaveBeenCalled();

  mocks.inLibrary.set("/new", 2);
  finishAdd();
  await done;
  expect(mocks.queue).toHaveBeenCalledWith([1, 2], t, queryClient);
  expect(mocks.show).toHaveBeenCalledWith({ color: "ok", message: "queued:7" });
});

it("skips and reports works the add failed to add", async () => {
  mocks.inLibrary.set("/added", 3);
  const add = Promise.reject(new ServerLibraryAddError("partial", { added: 1, failed: [{ error: "offline", work: work("failed") }], pending: [], skipped: 0 }));
  await downloadServerWorksOnce([work("added"), work("failed")], add, t, queryClient);
  expect(mocks.queue).toHaveBeenCalledWith([3], t, queryClient);
  expect(mocks.show).toHaveBeenCalledWith({ color: "warn", message: "queued:7", title: "serverLibraryAdd.downloadAllNotAdded:1" });
});

it("queues nothing when the add is cancelled", async () => {
  mocks.inLibrary.set("/existing", 1);
  await downloadServerWorksOnce([work("existing")], Promise.reject(new DOMException("Task was cancelled.", "AbortError")), t, queryClient);
  expect(mocks.queue).not.toHaveBeenCalled();
  expect(mocks.show).not.toHaveBeenCalled();
});

it("queues right away without an add and toasts a failure to queue", async () => {
  mocks.inLibrary.set("/existing", 1);
  mocks.queue.mockRejectedValueOnce(new Error("db closed"));
  await downloadServerWorksOnce([work("existing")], null, t, queryClient);
  expect(mocks.queue).toHaveBeenCalledWith([1], t, queryClient);
  expect(mocks.errorToast).toHaveBeenCalledWith("serverLibraryAdd.downloadAll", expect.any(Error));
});
