import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkPage, ServerWorkSummary } from "../lib/content-sync/browse";

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  stateIndex: 0,
  effects: [] as Array<() => void>,
  pages: [] as ServerWorkPage[],
  open: vi.fn(),
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
  useInfiniteQuery: () => ({ data: { pages: mocks.pages } }),
  useMutation: () => ({ mutate: mocks.open, isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../store/content-sync", () => ({ useContentSyncStore: (select: (state: { serverUrl: string; deviceName: string }) => unknown) => select({ serverUrl: "http://server", deviceName: "Phone" }) }));
vi.mock("../lib/use-library-novel-membership", () => ({ useLibraryNovelMembership: () => () => false }));

import { ContentServerBrowse } from "./ContentServerBrowse";
import { ServerWorkDeleteButton } from "./ServerWorkDeleteButton";

interface ControlProps {
  children?: ReactNode;
  disabled?: boolean;
  source?: { workId: string };
  onOpenChange?: (opened: boolean) => void;
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
