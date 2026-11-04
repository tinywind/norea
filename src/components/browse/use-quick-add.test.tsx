import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWorkSummary } from "../../lib/content-sync/browse";
import type { NovelItem, Plugin } from "../../lib/plugins/types";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  getNovelById: vi.fn(),
  invalidate: vi.fn(),
  markDirty: vi.fn(),
  openServerNovel: vi.fn(),
  saveCover: vi.fn(),
  setInLibrary: vi.fn(),
  show: vi.fn(),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { hide: vi.fn(), show: mocks.show } }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/novel", () => ({ getNovelById: mocks.getNovelById, setNovelInLibrary: mocks.setInLibrary }));
vi.mock("../../lib/content-sync/browse", () => ({ openServerNovel: mocks.openServerNovel }));
vi.mock("../../lib/novel-cover-storage", () => ({ saveNovelCoverFromSource: mocks.saveCover }));
vi.mock("../../lib/plugins/open-novel-task", () => ({ enqueueOpenNovelFromSourceTask: mocks.enqueue }));
vi.mock("../../lib/updates/update-index-events", () => ({ markUpdatesIndexDirty: mocks.markDirty }));
vi.mock("../novel/NovelCategoryEditor", () => ({ NovelCategoryEditor: () => null }));

import { addQuickAddTargetToLibrary, quickAddKey, useQuickAddToLibrary, type QuickAddTarget } from "./use-quick-add";

const plugin = { id: "source-a", name: "Source A" } as Plugin;
const item: NovelItem = { cover: "/cover.jpg", name: "Book", path: "/book" };
const sourceTarget: QuickAddTarget = { kind: "source", item, plugin };
const work = { id: "w1", novel: { name: "Server book" }, identity: { novelPath: "/book", pluginId: "source-a" } } as ServerWorkSummary;
const serverTarget: QuickAddTarget = { kind: "server", server: "http://server", work };

let root: Root;
let quickAdd: ReturnType<typeof useQuickAddToLibrary>;

function Probe() {
  quickAdd = useQuickAddToLibrary();
  return null;
}

function messageText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(messageText).join(" ");
  return isValidElement<{ children?: ReactNode }>(node) ? messageText(node.props.children) : "";
}

function toastButton(call: number, label: string): ReactElement<{ onClick: () => void }> {
  const find = (node: ReactNode): ReactElement<{ onClick: () => void }> | undefined => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return undefined;
    if (node.props.children === label && node.props.onClick) return node as ReactElement<{ onClick: () => void }>;
    return find(node.props.children);
  };
  return find(mocks.show.mock.calls[call]![0].message)!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.enqueue.mockReturnValue({ promise: Promise.resolve(7) });
  mocks.getNovelById.mockResolvedValue({ cover: "/cover.jpg", id: 7, isLocal: false, name: "Book", path: "/book", pluginId: "source-a" });
  mocks.openServerNovel.mockResolvedValue(9);
  mocks.saveCover.mockResolvedValue(undefined);
  const document = { nodeType: 9, activeElement: null, body: null as unknown, documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Node", class {});
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("addQuickAddTargetToLibrary", () => {
  it("imports a source item in the background, shelves it and stores its cover", async () => {
    await expect(addQuickAddTargetToLibrary(sourceTarget, "Add Book")).resolves.toBe(7);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ item, plugin, priority: "user", title: "Add Book" }));
    expect(mocks.setInLibrary).toHaveBeenCalledWith(7, true);
    expect(mocks.markDirty).toHaveBeenCalledWith("library-membership");
    expect(mocks.saveCover).toHaveBeenCalledWith(plugin, expect.objectContaining({ id: 7 }), "/cover.jpg");
  });

  it("installs a server work through the server path without a source cover save", async () => {
    await expect(addQuickAddTargetToLibrary(serverTarget, "Add")).resolves.toBe(9);
    expect(mocks.openServerNovel).toHaveBeenCalledWith("http://server", work);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.setInLibrary).toHaveBeenCalledWith(9, true);
    expect(mocks.saveCover).not.toHaveBeenCalled();
  });
});

describe("useQuickAddToLibrary", () => {
  it("keys source items and server works apart", () => {
    expect(quickAddKey(sourceTarget)).not.toBe(quickAddKey(serverTarget));
  });

  it("marks the item pending, ignores repeats and toasts Added with Change category", async () => {
    let finish!: (id: number) => void;
    mocks.enqueue.mockReturnValue({ promise: new Promise<number>((resolve) => { finish = resolve; }) });

    await act(async () => quickAdd.add(sourceTarget));
    expect(quickAdd.isPending(sourceTarget)).toBe(true);
    await act(async () => quickAdd.add(sourceTarget));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    await act(async () => finish(7));
    expect(quickAdd.isPending(sourceTarget)).toBe(false);
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.show.mock.calls[0]![0].color).toBe("ok");
    expect(messageText(mocks.show.mock.calls[0]![0].message)).toContain("quickAdd.added");

    await act(async () => toastButton(0, "quickAdd.changeCategory").props.onClick());
    expect(quickAdd.categorySheet).not.toBeNull();
  });

  it("toasts Couldn't add with a Retry that runs the add again", async () => {
    mocks.enqueue.mockReturnValueOnce({
      promise: Promise.reject(new Error("scraper: browser fetch failed: Failed to fetch")),
    });
    await act(async () => quickAdd.add(sourceTarget));
    expect(mocks.show.mock.calls[0]![0]).toEqual(expect.objectContaining({ color: "danger", title: "quickAdd.failed" }));
    expect(messageText(mocks.show.mock.calls[0]![0].message)).toContain("errors.network");
    expect(messageText(mocks.show.mock.calls[0]![0].message)).not.toContain("Failed to fetch");

    await act(async () => toastButton(0, "common.retry").props.onClick());
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.setInLibrary).toHaveBeenCalledWith(7, true);
  });
});
