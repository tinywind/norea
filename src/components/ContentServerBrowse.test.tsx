import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkPage, ServerWorkSummary } from "../lib/content-sync/browse";

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  stateIndex: 0,
  effects: [] as Array<() => void>,
  pages: [] as ServerWorkPage[],
  open: vi.fn(),
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
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[2] === "device" ? "device" : { items: [] } }),
  useInfiniteQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    mocks.browseQueryKeys.push(queryKey);
    return { data: { pages: mocks.pages } };
  },
  useMutation: () => ({ mutate: mocks.open, isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../store/content-sync", () => ({ useContentSyncStore: (select: (state: { serverUrl: string; deviceName: string }) => unknown) => select({ serverUrl: mocks.server, deviceName: "Phone" }) }));
vi.mock("../store/content-server-browse", async original => {
  const actual = await original<typeof import("../store/content-server-browse")>();
  const store = actual.useContentServerBrowseStore;
  return { ...actual, useContentServerBrowseStore: Object.assign(
    (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()),
    store,
  ) };
});
vi.mock("../lib/use-library-novel-membership", () => ({ useLibraryNovelMembership: () => () => false }));

import { ContentServerBrowse } from "./ContentServerBrowse";
import { ServerWorkDeleteButton } from "./ServerWorkDeleteButton";
import { SearchBar } from "./SearchBar";
import { Select } from "@mantine/core";
import { useContentServerBrowseStore } from "../store/content-server-browse";

interface ControlProps {
  children?: ReactNode;
  disabled?: boolean;
  source?: { workId: string };
  onOpenChange?: (opened: boolean) => void;
  value?: string;
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
  return controls(ContentServerBrowse({ active: true }));
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.state.length = 0;
  mocks.server = "http://server";
  mocks.browseQueryKeys.length = 0;
  useContentServerBrowseStore.setState({ filtersByServer: {} });
  mocks.pages = [{ items: [work("first"), work("second")], total: 2, hasMore: false }];
});

it("unlocks the remaining cards when a refetch removes the work whose confirmation was open", () => {
  const first = render().find(element => element.type === ServerWorkDeleteButton && element.props.source?.workId === "first")!;
  first.props.onOpenChange!(true);
  expect(render().filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
  mocks.pages = [{ items: [work("second")], total: 1, hasMore: false }];
  render();
  mocks.effects.at(-1)!();
  const remaining = render();
  expect(remaining.find(element => element.type === "button")!.props.disabled).toBe(false);
  expect(remaining.find(element => element.type === ServerWorkDeleteButton)!.props.disabled).toBe(false);
  expect(mocks.open).not.toHaveBeenCalled();
});

it("does not let an old removed card close another work's confirmation", () => {
  const first = render().find(element => element.type === ServerWorkDeleteButton && element.props.source?.workId === "first")!;
  first.props.onOpenChange!(true);
  mocks.pages = [{ items: [work("second")], total: 1, hasMore: false }];
  render(); mocks.effects.at(-1)!();
  const second = render().find(element => element.type === ServerWorkDeleteButton)!;
  second.props.onOpenChange!(true);
  first.props.onOpenChange!(false);
  expect(render().find(element => element.type === "button")!.props.disabled).toBe(true);
});

it("retains the search and source when returning from a work", () => {
  render().find(element => element.type === SearchBar)!.props.onChange!("  saved search  ");
  render().find(element => element.type === SearchBar)!.props.onSubmit!();
  render().find(element => element.type === Select)!.props.onChange!("source-a");

  mocks.state.length = 0;
  render();
  mocks.effects.forEach(effect => effect());
  const returned = render();
  expect(returned.find(element => element.type === SearchBar)!.props.value).toBe("  saved search  ");
  expect(returned.find(element => element.type === Select)!.props.value).toBe("source-a");
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
