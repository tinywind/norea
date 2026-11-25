import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkPage, ServerWorkSummary } from "../../lib/content-sync/browse";

// The persisted filter store binds its storage on import, before any test hook runs.
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  stateIndex: 0,
  effects: [] as Array<() => void>,
  pages: [] as ServerWorkPage[],
  open: vi.fn(),
  quickAdd: vi.fn(),
  navigate: vi.fn(),
  server: "http://server",
  browseQueryKeys: [] as unknown[][],
  inLibrary: new Set<string>(),
  categories: new Map<string, string[]>(),
  categoryLookups: [] as unknown[][],
  bulkRequest: vi.fn(),
  confirmDeletion: vi.fn(async (_input: unknown) => false),
  downloadAll: vi.fn(),
  selection: {
    allSelected: false, deselectAll: vi.fn(), enter: vi.fn(), exit: vi.fn(), gathering: null as { loaded: number; total: number } | null,
    selected: new Map<string, unknown>(), selectAll: vi.fn(), selectionMode: false, toggle: vi.fn(),
  },
  selectionOptions: [] as unknown[],
}));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.state)) mocks.state[index] = initial;
    return [mocks.state[index], (next: unknown) => {
      mocks.state[index] = typeof next === "function" ? next(mocks.state[index]) : next;
    }];
  },
  useEffect: (effect: () => void) => { mocks.effects.push(effect); },
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "plugin"
      ? [{ id: "source-a", name: "Source A" }]
      : queryKey[2] === "device"
        ? "device"
        : {
          categories: [{ id: "cat-1", name: "Reading", workCount: 2 }],
          sources: [{ id: "source-a", workCount: 2 }, { id: "source-b", workCount: 1 }],
          statuses: [{ status: "Ongoing", workCount: 2 }, { status: "Completed", workCount: 1 }],
          tags: [{ tag: "Fantasy", workCount: 2 }],
          uncategorizedCount: 1,
        },
  }),
  useInfiniteQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    mocks.browseQueryKeys.push(queryKey);
    return { data: { pages: mocks.pages } };
  },
  useMutation: () => ({ mutate: mocks.open, isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../store/content-deletion", () => ({ confirmContentDeletion: (input: unknown) => mocks.confirmDeletion(input) }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: (select: (state: { serverUrl: string; deviceName: string }) => unknown) => select({ serverUrl: mocks.server, deviceName: "Phone" }) }));
vi.mock("../../store/content-server-browse", async original => {
  const actual = await original<typeof import("../../store/content-server-browse")>();
  const store = actual.useContentServerBrowseStore;
  return { ...actual, useContentServerBrowseStore: Object.assign(
    (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()),
    store,
  ) };
});
vi.mock("../../lib/use-library-novel-membership", () => ({ useLibraryNovelMembership: () => (_pluginId: string, path: string) => mocks.inLibrary.has(path) }));
vi.mock("../../lib/content-sync/use-server-work-categories", () => ({
  useServerWorkCategories: (...args: unknown[]) => { mocks.categoryLookups.push(args); return (_pluginId: string, path: string) => mocks.categories.get(path) ?? []; },
}));
vi.mock("./use-server-work-selection", () => ({
  useServerWorkSelection: (options: unknown) => { mocks.selectionOptions.push(options); return mocks.selection; },
}));
vi.mock("./use-server-library-add", () => ({ useServerLibraryAdd: () => ({ request: mocks.bulkRequest }) }));
vi.mock("./server-download-all", () => ({ downloadServerWorksOnce: mocks.downloadAll }));
vi.mock("./use-quick-add", () => ({
  useQuickAddToLibrary: () => ({ add: mocks.quickAdd, categorySheet: null, isPending: () => false }),
}));

import { BrowseServerTab } from "./BrowseServerTab";
import { QuickAddCard } from "./QuickAddCard";
import { SearchBar } from "../SearchBar";
import { ServerBrowseFilters } from "./ServerBrowseFilters";
import { StateView } from "../AppFrame";
import { useContentServerBrowseStore } from "../../store/content-server-browse";
import { IconButton } from "../IconButton";
import { SelectionAction, SelectionBar } from "../ui/SelectionBar";

interface ControlProps {
  "aria-pressed"?: boolean;
  selected?: boolean;
  "aria-label"?: string;
  action?: { onClick: () => void };
  actions?: ReactNode;
  allSelected?: boolean;
  label?: string;
  onSelect?: () => void;
  onSelectAll?: () => void;
  children?: ReactNode;
  disabled?: boolean;
  value?: string;
  onAdd?: () => void;
  onClick?: () => void;
  onOpen?: () => void;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  title?: ReactNode;
}
function controls(node: ReactNode): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ControlProps>;
  return [element, ...controls(element.props.children), ...controls(element.props.actions)];
}
const work = (id: string) => ({ id, novel: { name: id }, identity: { pluginId: "plugin", novelPath: `/${id}` } }) as ServerWorkSummary;
const render = () => {
  mocks.stateIndex = 0; mocks.effects.length = 0;
  return controls(BrowseServerTab({ active: true }));
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.state.length = 0;
  mocks.server = "http://server";
  mocks.browseQueryKeys.length = 0;
  useContentServerBrowseStore.setState({ filtersByServer: {} });
  mocks.pages = [{ items: [work("first"), work("second")], total: 2, hasMore: false }];
  mocks.inLibrary.clear();
  mocks.categories.clear();
  mocks.categoryLookups.length = 0;
  mocks.selectionOptions.length = 0;
  Object.assign(mocks.selection, { allSelected: false, gathering: null, selected: new Map(), selectionMode: false });
});

const toolbarAction = (elements: ReactElement<ControlProps>[], label: string) =>
  elements.find(element => element.type === IconButton && element.props.label === label)!.props;

type FiltersProps = Parameters<typeof ServerBrowseFilters>[0];
const filters = (elements: ReactElement<ControlProps>[]) =>
  (elements.find(element => element.type === ServerBrowseFilters) as unknown as ReactElement<FiltersProps>).props;

it("names server sources after installed plugins and falls back to the id", () => {
  const props = filters(render());
  expect(props.sources.map(source => props.sourceName(source.id))).toEqual(["Source A", "source-b"]);
  expect(props.categories).toEqual([{ id: "cat-1", name: "Reading", workCount: 2 }]);
  expect(props.statuses).toEqual([{ status: "Ongoing", workCount: 2 }, { status: "Completed", workCount: 1 }]);
  expect(props.tags).toEqual([{ tag: "Fantasy", workCount: 2 }]);
  expect(props.uncategorizedCount).toBe(1);
  expect(props.filter).toEqual({
    categories: [],
    query: "",
    source: "",
    statuses: [],
    tags: [],
    uncategorized: false,
  });
});

it("browses only the chosen statuses, categories, and tags and keeps them for add all and select all", () => {
  filters(render()).onChange({ categories: ["cat-1"], statuses: ["Completed"], tags: ["Fantasy"], uncategorized: true });
  const elements = render();
  expect(filters(elements).filter.statuses).toEqual(["Completed"]);
  expect(filters(elements).filter.categories).toEqual(["cat-1"]);
  expect(filters(elements).filter.uncategorized).toBe(true);
  expect(filters(elements).filter.tags).toEqual(["Fantasy"]);
  expect(mocks.browseQueryKeys.at(-1)).toEqual([
    "content-server", "http://server", "browse", "", "", ["Completed"], ["cat-1"], true, ["Fantasy"],
  ]);
  const expectedFilter = {
    categories: ["cat-1"],
    query: "",
    source: "",
    statuses: ["Completed"],
    tags: ["Fantasy"],
    uncategorized: true,
  };
  expect(mocks.selectionOptions.at(-1)).toMatchObject({ filter: expectedFilter });
  toolbarAction(elements, "serverLibraryAdd.addAll").onClick!();
  expect(mocks.bulkRequest).toHaveBeenCalledWith({ count: 2, works: expectedFilter });
});

it("shows the user's categories on the cards of the works that have them", () => {
  mocks.categories.set("/first", ["Later", "Favorites"]);
  const elements = render();
  expect(mocks.categoryLookups.at(-1)).toEqual(["http://server", [work("first").identity, work("second").identity], true]);
  const labels = elements.filter(element => element.type === "span" && element.props["aria-label"]?.startsWith("categories.title"));
  expect(labels.map(label => label.props.children)).toEqual(["Later, Favorites"]);
});

it("opens a work from its card and offers no server deletion on the grid", () => {
  const cards = render().filter(element => element.type === QuickAddCard);
  expect(cards).toHaveLength(2);
  cards[0]!.props.onOpen!();
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "first" }));
  expect(JSON.stringify(cards.map(card => card.props.children))).not.toContain("deleteServer");
});

it("quick adds a server work through the server install path", () => {
  const cards = render().filter(element => element.type === QuickAddCard);
  cards[1]!.props.onAdd!();
  expect(mocks.quickAdd).toHaveBeenCalledWith({ kind: "server", server: "http://server", work: expect.objectContaining({ id: "second" }) });
  expect(mocks.open).not.toHaveBeenCalled();
});

it("links to the content server settings when no server is configured", () => {
  mocks.server = "";
  const state = render().find(element => element.type === StateView)!;
  state.props.action!.onClick();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "backup" } });
});

it("retains the search and source when returning from a work", () => {
  render().find(element => element.type === SearchBar)!.props.onChange!("  saved search  ");
  render().find(element => element.type === SearchBar)!.props.onSubmit!();
  filters(render()).onChange({ source: "source-a" });

  mocks.state.length = 0;
  render();
  mocks.effects.forEach(effect => effect());
  const returned = render();
  expect(returned.find(element => element.type === SearchBar)!.props.value).toBe("  saved search  ");
  expect(filters(returned).filter.source).toBe("source-a");
  expect(mocks.browseQueryKeys.at(-1)).toEqual([
    "content-server", "http://server", "browse", "saved search", "source-a", [], [], false, [],
  ]);
});

it("keeps filters separate for each content server", () => {
  render().find(element => element.type === SearchBar)!.props.onChange!("first server");
  render().find(element => element.type === SearchBar)!.props.onSubmit!();
  mocks.server = "http://other-server";
  expect(render().find(element => element.type === SearchBar)!.props.value).toBe("");
  expect(mocks.browseQueryKeys.at(-1)).toEqual([
    "content-server", "http://other-server", "browse", "", "", [], [], false, [],
  ]);
  mocks.server = "http://server";
  expect(render().find(element => element.type === SearchBar)!.props.value).toBe("first server");
});

it("offers adding every matching server work, including unloaded pages, from the toolbar", () => {
  mocks.pages = [{ items: [work("first"), work("second")], total: 120, hasMore: true }];
  useContentServerBrowseStore.getState().setFilters("http://server", { query: "saga", source: "source-a" });
  toolbarAction(render(), "serverLibraryAdd.addAll").onClick!();
  expect(mocks.bulkRequest).toHaveBeenCalledWith({
    count: 120,
    works: { categories: [], query: "saga", source: "source-a", statuses: [], tags: [], uncategorized: false },
  });
});

it("enters selection from the toolbar or a card's long press", () => {
  const elements = render();
  toolbarAction(elements, "library.selection.start").onClick!();
  expect(mocks.selection.enter).toHaveBeenCalledWith();
  elements.filter(element => element.type === QuickAddCard)[1]!.props.onSelect!();
  expect(mocks.selection.enter).toHaveBeenLastCalledWith(expect.objectContaining({ id: "second" }));
  expect(mocks.selectionOptions.at(-1)).toMatchObject({
    filter: { categories: [], query: "", source: "", statuses: [], tags: [], uncategorized: false },
    server: "http://server",
    token: "device",
  });
});

it("toggles works in selection mode, works in the library included", () => {
  mocks.inLibrary.add("/second");
  Object.assign(mocks.selection, { selectionMode: true, selected: new Map([["second", work("second")]]) });
  const elements = render();
  expect(elements.filter(element => element.type === QuickAddCard)).toHaveLength(0);
  expect(elements.some(element => element.type === SearchBar)).toBe(false);
  const cards = elements.filter(element => element.type === "button" && element.props["aria-label"] === "library.selection.selectNamed");
  expect(cards.map(card => [card.props["aria-pressed"], card.props.disabled])).toEqual([[false, undefined], [true, undefined]]);
  const checks = elements.filter(element => element.type === "span" && (element.props as { className?: string }).className === "norea-source-select-check");
  expect(checks).toHaveLength(2);
  cards[1]!.props.onClick!();
  expect(mocks.selection.toggle).toHaveBeenCalledWith(expect.objectContaining({ id: "second" }));
});

it("keeps selecting when every shown work is already in the library", () => {
  mocks.inLibrary.add("/first");
  mocks.inLibrary.add("/second");
  const select = toolbarAction(render(), "library.selection.start");
  expect(select.disabled).toBe(false);
  Object.assign(mocks.selection, { selectionMode: true });
  expect(render().some(element => element.type === StateView)).toBe(false);

  const css = readFileSync(new URL("../../styles/browse.css", import.meta.url), "utf8");
  expect(css).not.toContain("data-in-library");
  expect(css).toMatch(/\.norea-source-select-check \{[^}]*border: 0\.125rem solid #fff;/);
  const title = /\.norea-source-card-title \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(title).toContain("-webkit-line-clamp: 2");
  expect(title).toContain("font-weight: var(--norea-weight-medium)");
});

const action = (elements: ReactElement<ControlProps>[], label: string) =>
  elements.find(element => element.type === SelectionAction && element.props.label === label)!;

it("adds only the selected works not in the library yet through one bulk request", () => {
  mocks.inLibrary.add("/second");
  Object.assign(mocks.selection, { selectionMode: true, selected: new Map([["first", work("first")], ["second", work("second")]]) });
  const elements = render();
  const bar = elements.find(element => element.type === SelectionBar)!;
  expect(bar.props.label).toBe("library.selectedCount");
  bar.props.onSelectAll!();
  expect(mocks.selection.selectAll).toHaveBeenCalled();
  action(elements, "quickAdd.add").props.onClick!();
  expect(mocks.bulkRequest).toHaveBeenCalledWith({ count: 1, onStarted: mocks.selection.exit, works: [expect.objectContaining({ id: "first" })] });
});

it("disables adding when every selected work is already in the library", () => {
  mocks.inLibrary.add("/first");
  Object.assign(mocks.selection, { selectionMode: true, selected: new Map([["first", work("first")]]) });
  const elements = render();
  expect(action(elements, "quickAdd.add").props.disabled).toBe(true);
  expect(action(elements, "serverLibraryAdd.downloadAll").props.disabled).toBe(false);
});

it("downloads every selected work's chapters after adding the new ones", () => {
  mocks.inLibrary.add("/second");
  Object.assign(mocks.selection, { selectionMode: true, selected: new Map([["first", work("first")], ["second", work("second")]]) });
  action(render(), "serverLibraryAdd.downloadAll").props.onClick!();
  expect(mocks.bulkRequest).toHaveBeenCalledWith({
    count: 1,
    downloadChaptersOf: [expect.objectContaining({ id: "first" }), expect.objectContaining({ id: "second" })],
    onStarted: mocks.selection.exit,
    works: [expect.objectContaining({ id: "first" })],
  });
  expect(mocks.downloadAll).not.toHaveBeenCalled();
});

it("downloads right away when every selected work is already in the library", () => {
  mocks.inLibrary.add("/first");
  mocks.inLibrary.add("/second");
  Object.assign(mocks.selection, { selectionMode: true, selected: new Map([["first", work("first")], ["second", work("second")]]) });
  action(render(), "serverLibraryAdd.downloadAll").props.onClick!();
  expect(mocks.bulkRequest).not.toHaveBeenCalled();
  expect(mocks.selection.exit).toHaveBeenCalled();
  expect(mocks.downloadAll).toHaveBeenCalledWith(
    [expect.objectContaining({ id: "first" }), expect.objectContaining({ id: "second" })], null, expect.any(Function), expect.anything(), "http://server");
});

it("deletes selected server works through the confirmation dialog and exits selection only when deletion succeeds", async () => {
  Object.assign(mocks.selection, { selectionMode: true, selected: new Map() });
  expect(action(render(), "serverLibraryAdd.deleteFromServer").props.disabled).toBe(true);

  Object.assign(mocks.selection, { selectionMode: true, selected: new Map([["first", work("first")], ["second", work("second")]]) });
  mocks.confirmDeletion.mockResolvedValueOnce(false);
  const deleteAction = action(render(), "serverLibraryAdd.deleteFromServer");
  expect(deleteAction.props.disabled).toBe(false);
  deleteAction.props.onClick!();
  await vi.waitFor(() => {
    expect(action(render(), "serverLibraryAdd.deleteFromServer").props.disabled).toBe(false);
  });
  expect(mocks.confirmDeletion).toHaveBeenCalledWith({
    kind: "server-works",
    title: "serverLibraryAdd.deleteSelectedConfirm",
    works: [
      { identity: { pluginId: "plugin", novelPath: "/first" }, name: "first", source: { serverUrl: "http://server", workId: "first" } },
      { identity: { pluginId: "plugin", novelPath: "/second" }, name: "second", source: { serverUrl: "http://server", workId: "second" } },
    ],
  });
  expect(mocks.selection.exit).not.toHaveBeenCalled();

  mocks.confirmDeletion.mockResolvedValueOnce(true);
  action(render(), "serverLibraryAdd.deleteFromServer").props.onClick!();
  await vi.waitFor(() => {
    expect(mocks.selection.exit).toHaveBeenCalledOnce();
  });
});
