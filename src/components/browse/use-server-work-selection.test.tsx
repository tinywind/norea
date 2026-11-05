import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkSummary } from "../../lib/content-sync/browse";

const mocks = vi.hoisted(() => ({
  backNavigation: vi.fn(),
  errorToast: vi.fn(),
  listAll: vi.fn(),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/android-back-navigation", () => ({ useOverlayBackNavigation: mocks.backNavigation }));
vi.mock("../../lib/content-sync/browse", () => ({ listAllServerWorks: mocks.listAll }));
vi.mock("../../lib/runtime/error-toast", () => ({ showErrorToast: mocks.errorToast }));

import { useServerWorkSelection } from "./use-server-work-selection";

const work = (id: string) => ({ id, novel: { name: id }, identity: { pluginId: "source", novelPath: `/${id}` } }) as ServerWorkSummary;

let root: Root;
let selection: ReturnType<typeof useServerWorkSelection>;
let filters = { query: "", source: "" };

function Probe() {
  selection = useServerWorkSelection({ active: true, server: "http://server", token: "device", ...filters });
  return null;
}
const render = () => act(async () => root.render(<Probe />));

beforeEach(async () => {
  vi.clearAllMocks();
  filters = { query: "", source: "" };
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
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("enters selection and toggles any work, including one already in the library", async () => {
  await act(async () => selection.enter(work("a")));
  expect(selection.selectionMode).toBe(true);
  expect([...selection.selected.keys()]).toEqual(["a"]);
  await act(async () => selection.toggle(work("b")));
  await act(async () => selection.toggle(work("c")));
  await act(async () => selection.toggle(work("a")));
  expect([...selection.selected.keys()]).toEqual(["b", "c"]);
  expect(mocks.backNavigation).toHaveBeenLastCalledWith(true, selection.exit);

  await act(async () => selection.exit());
  expect(selection.selectionMode).toBe(false);
  expect(selection.selected.size).toBe(0);
});

it("selects every matching work across unloaded pages, works in the library included", async () => {
  let finish!: (works: ServerWorkSummary[]) => void;
  mocks.listAll.mockImplementation((_server, _token, _query, _source, onPage: (loaded: number, total: number) => void) => {
    onPage(100, 250);
    return new Promise((resolve) => { finish = resolve; });
  });
  filters = { query: "saga", source: "source" };
  await render();
  await act(async () => selection.enter());
  await act(async () => selection.selectAll());
  expect(mocks.listAll).toHaveBeenCalledWith("http://server", "device", "saga", "source", expect.any(Function), expect.any(AbortSignal));
  expect(selection.gathering).toEqual({ loaded: 100, total: 250 });

  await act(async () => finish([work("a"), work("b"), work("c")]));
  expect(selection.gathering).toBeNull();
  expect([...selection.selected.keys()]).toEqual(["a", "b", "c"]);
  expect(selection.allSelected).toBe(true);

  await act(async () => selection.toggle(work("a")));
  expect(selection.allSelected).toBe(false);
});

it("discards a gather in flight and clears the selection when the filters change", async () => {
  let signal!: AbortSignal;
  let finish!: (works: ServerWorkSummary[]) => void;
  mocks.listAll.mockImplementation((_server, _token, _query, _source, _onPage, abort: AbortSignal) => {
    signal = abort;
    return new Promise((resolve) => { finish = resolve; });
  });
  await act(async () => selection.enter(work("a")));
  await act(async () => selection.selectAll());
  filters = { query: "other", source: "" };
  await render();
  expect(signal.aborted).toBe(true);
  expect(selection.selected.size).toBe(0);
  await act(async () => finish([work("x")]));
  expect(selection.selected.size).toBe(0);
  expect(selection.gathering).toBeNull();
});
