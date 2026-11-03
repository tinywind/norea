import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkPage, ServerWorkSummary } from "../../lib/content-sync/browse";

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  stateIndex: 0,
  effects: [] as Array<() => void>,
  pages: [] as ServerWorkPage[],
  open: vi.fn(),
  navigate: vi.fn(),
  server: "http://server",
  browseQueryKeys: [] as unknown[][],
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
      : queryKey[2] === "device" ? "device" : { items: [{ id: "source-a", workCount: 2 }, { id: "source-b", workCount: 1 }] },
  }),
  useInfiniteQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    mocks.browseQueryKeys.push(queryKey);
    return { data: { pages: mocks.pages } };
  },
  useMutation: () => ({ mutate: mocks.open, isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: (select: (state: { serverUrl: string; deviceName: string }) => unknown) => select({ serverUrl: mocks.server, deviceName: "Phone" }) }));
vi.mock("../../store/content-server-browse", async original => {
  const actual = await original<typeof import("../../store/content-server-browse")>();
  const store = actual.useContentServerBrowseStore;
  return { ...actual, useContentServerBrowseStore: Object.assign(
    (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()),
    store,
  ) };
});
vi.mock("../../lib/use-library-novel-membership", () => ({ useLibraryNovelMembership: () => () => false }));

import { BrowseServerTab } from "./BrowseServerTab";
import { SearchBar } from "../SearchBar";
import { Button } from "@mantine/core";
import { StateView } from "../AppFrame";
import { useContentServerBrowseStore } from "../../store/content-server-browse";

interface ControlProps {
  "aria-pressed"?: boolean;
  action?: { onClick: () => void };
  children?: ReactNode;
  disabled?: boolean;
  value?: string;
  onClick?: () => void;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
}
function controls(node: ReactNode): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ControlProps>;
  return [element, ...controls(element.props.children)];
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
});

const chip = (elements: ReactElement<ControlProps>[], label: string) =>
  elements.find(element => element.type === Button && element.props.children === label)!;

it("names source chips after installed plugins and falls back to the id", () => {
  const elements = render();
  expect(chip(elements, "Source A")).toBeDefined();
  expect(chip(elements, "source-b")).toBeDefined();
  expect(chip(elements, "contentSync.allSources").props["aria-pressed"]).toBe(true);
});

it("opens a work from its card and offers no server deletion on the grid", () => {
  const cards = render().filter(element => element.type === "button");
  expect(cards).toHaveLength(2);
  cards[0]!.props.onClick!();
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "first" }));
  expect(JSON.stringify(cards.map(card => card.props.children))).not.toContain("deleteServer");
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
  chip(render(), "Source A").props.onClick!();

  mocks.state.length = 0;
  render();
  mocks.effects.forEach(effect => effect());
  const returned = render();
  expect(returned.find(element => element.type === SearchBar)!.props.value).toBe("  saved search  ");
  expect(chip(returned, "Source A").props["aria-pressed"]).toBe(true);
  expect(mocks.browseQueryKeys.at(-1)).toEqual(["content-server", "http://server", "browse", "saved search", "source-a"]);
});

it("keeps filters separate for each content server", () => {
  render().find(element => element.type === SearchBar)!.props.onChange!("first server");
  render().find(element => element.type === SearchBar)!.props.onSubmit!();
  mocks.server = "http://other-server";
  expect(render().find(element => element.type === SearchBar)!.props.value).toBe("");
  expect(mocks.browseQueryKeys.at(-1)).toEqual(["content-server", "http://other-server", "browse", "", ""]);
  mocks.server = "http://server";
  expect(render().find(element => element.type === SearchBar)!.props.value).toBe("first server");
});
