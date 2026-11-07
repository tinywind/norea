import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterTypes, type Filters } from "../lib/plugins/filterTypes";
import { emptySourceFilterValues } from "../lib/plugins/source-filter-storage";
import type { Plugin } from "../lib/plugins/types";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  listing: {} as Record<string, unknown>,
  navigate: vi.fn(),
  open: { error: null, isPending: false, mutate: vi.fn() } as Record<string, unknown>,
  plugins: [] as unknown[],
}));

vi.mock("../components/PdfReaderContent", () => ({ PdfReaderContent: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: () => "/source?pluginId=demo",
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => mocks.open,
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    queryKey[1] === "installed"
      ? { data: mocks.plugins, isLoading: false }
      : queryKey[0] === "novel"
        ? { data: [] }
        : mocks.listing,
  useQueryClient: () => ({ cancelQueries: vi.fn(), invalidateQueries: vi.fn() }),
}));
vi.mock("../i18n", async (original) => ({
  ...(await original<typeof import("../i18n")>()),
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../lib/tasks/scheduler", async (original) => ({
  ...(await original<typeof import("../lib/tasks/scheduler")>()),
  taskScheduler: { cancel: mocks.cancel },
}));

const { canLoadSourceListing, SourcePage } = await import("./source");
const { BlockingLoadingOverlay, PageHeader, StateView } = await import("../components/AppFrame");
const { CoverGridSkeleton } = await import("../components/browse/CoverGridSkeleton");
const { PluginFilters } = await import("../components/PluginFilters");
const { ResponsiveSheet } = await import("../components/ui/ResponsiveSheet");

const genreFilters: Filters = {
  genre: {
    label: "Genre",
    options: [
      { label: "Fantasy", value: "fantasy" },
      { label: "Drama", value: "drama" },
    ],
    type: FilterTypes.CheckboxGroup,
    value: [],
  },
};

function plugin(filters?: Filters): Plugin {
  return {
    id: "demo", name: "Demo Source", lang: "en", version: "1", url: "", iconUrl: "", apiVersion: "0.2",
    filters, getBaseUrl: () => "https://demo.example",
  } as Plugin;
}

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

beforeEach(() => {
  mocks.plugins = [plugin(genreFilters)];
  mocks.listing = { data: undefined, error: null, isFetching: true, refetch: vi.fn() };
  mocks.open = { error: null, isPending: false, mutate: vi.fn() };
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

async function mountPage() {
  function Probe() {
    tree = SourcePage({ pluginId: "demo", query: "" });
    return null;
  }
  harness = mountBackNavigationHarness();
  await harness.render(<Probe />);
  return collectElements(tree);
}

const byType = (elements: ReactElement<Record<string, unknown>>[], type: unknown) =>
  elements.filter((element) => element.type === type);
const labelled = (elements: ReactElement<Record<string, unknown>>[], label: string) =>
  elements.find((element) => element.props.label === label || element.props["aria-label"] === label);

describe("SourcePage", () => {
  it("opens source reader settings directly when no plugin settings need an overflow", async () => {
    const elements = await mountPage();
    const header = elements.find((element) => element.type === PageHeader)!;
    expect(header.props.title).toBe("Demo Source");
    expect(header.props.onBack).toEqual(expect.any(Function));
    expect(labelled(elements, "common.openSite")).toBeDefined();
    await harness!.run(() => (labelled(elements, "source.readerSettings")!.props.onClick as () => void)());
    const panel = collectElements(tree).find((element) => element.props.target !== undefined);
    expect(panel!.props.target).toEqual({ kind: "source", sourceId: "demo", label: "Demo Source" });
  });

  it("keeps both source settings choices reachable while exposing Open site directly", async () => {
    mocks.plugins = [{ ...plugin(), pluginSettings: { token: { type: "Text", label: "Token", value: "" } } } as unknown as Plugin];
    const elements = await mountPage();
    expect(labelled(elements, "common.openSite")).toBeDefined();
    const menu = elements.find((element) => Array.isArray(element.props.items))!;
    const items = menu.props.items as { label: string; onClick: () => void }[];
    expect(items.map((item) => item.label)).toEqual(["source.sourceSettings", "source.readerSettings"]);
    await harness!.run(() => items.find((item) => item.label === "source.sourceSettings")!.onClick());
    const settings = collectElements(tree).find((element) => "plugin" in element.props && "onClose" in element.props);
    expect((settings!.props.plugin as Plugin).id).toBe("demo");
  });

  it("offers the filter button only when the plugin has filters", async () => {
    expect(labelled(await mountPage(), "source.filters")).toBeDefined();
    await harness!.unmount();
    mocks.plugins = [plugin()];
    expect(labelled(await mountPage(), "source.filters")).toBeUndefined();
  });

  it("shows grid skeletons, not a blocking overlay, while the first page loads", async () => {
    const elements = await mountPage();
    expect(byType(elements, CoverGridSkeleton)).toHaveLength(1);
    expect(byType(elements, BlockingLoadingOverlay)).toHaveLength(0);
  });

  it("offers Retry and Open site when the catalog fails", async () => {
    mocks.listing = { data: undefined, error: new Error("blocked"), isFetching: false, refetch: vi.fn() };
    const state = byType(await mountPage(), StateView)[0]!;
    const props = state.props as { action: { label: string; onClick: () => void }; secondaryAction: { label: string } };
    expect(props.action.label).toBe("common.retry");
    expect(props.secondaryAction.label).toBe("common.openSite");
    props.action.onClick();
    expect(mocks.listing.refetch).toHaveBeenCalled();
  });

  it("loads the next page near the grid end and keeps Load more as the fallback", async () => {
    mocks.plugins = [plugin()];
    const items = [{ name: "One", path: "/one" }];
    mocks.listing = {
      data: { items, page: 1, scopeKey: "filters||{}|demo" },
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    };
    const elements = await mountPage();
    const sentinel = elements.find((element) => typeof element.props.onNearEnd === "function")!;
    expect(sentinel.props.enabled).toBe(true);
    const loadMore = elements.find((element) => element.props.children === "common.loadMore")!;
    expect(loadMore.props.disabled).toBe(false);
    expect(loadMore.props.onClick).toBe(sentinel.props.onNearEnd);
  });

  it("stops loading automatically during a page request, after an error and at the end of the list", async () => {
    mocks.plugins = [plugin()];
    const data = { items: [{ name: "One", path: "/one" }], page: 1, scopeKey: "filters||{}|demo" };
    const sentinelEnabled = async () =>
      (await mountPage()).find((element) => typeof element.props.onNearEnd === "function")?.props.enabled;

    mocks.listing = { data, error: null, isFetching: true, refetch: vi.fn() };
    expect(await sentinelEnabled()).toBe(false);
    await harness!.unmount();
    mocks.listing = { data, error: new Error("blocked"), isFetching: false, refetch: vi.fn() };
    expect(await sentinelEnabled()).toBe(false);
    await harness!.unmount();
    mocks.listing = { data: { ...data, items: [] }, error: null, isFetching: false, refetch: vi.fn() };
    expect(await sentinelEnabled()).not.toBe(true);
  });

  it("keeps the page when Cancel stops opening a novel", async () => {
    mocks.open = { error: null, isPending: true, mutate: vi.fn() };
    const overlay = byType(await mountPage(), BlockingLoadingOverlay)[0]!;
    (overlay.props.onCancel as () => void)();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("shows applied filters as chips that remove one value each", async () => {
    let elements = await mountPage();
    const filters = byType(elements, PluginFilters)[0]!;
    await harness!.run(() =>
      (filters.props.onChange as (values: unknown) => void)({
        genre: { type: FilterTypes.CheckboxGroup, value: ["fantasy"] },
      }),
    );
    elements = collectElements(tree);
    const sheet = byType(elements, ResponsiveSheet)[0]!;
    const apply = collectElements(sheet.props.footer as ReactNode).find(
      (element) => element.props.children === "common.apply",
    )!;
    await harness!.run(() => (apply.props.onClick as () => void)());

    elements = collectElements(tree);
    const chip = labelled(elements, "source.removeFilter")
      ?? elements.find((element) => element.props.children === "Genre: Fantasy");
    expect(chip).toBeDefined();
    await harness!.run(() => (chip!.props.onClick as () => void)());
    expect(collectElements(tree).find((element) => element.props.children === "Genre: Fantasy")).toBeUndefined();
  });
});

describe("canLoadSourceListing", () => {
  const demo = { id: "newtoki-webtoon" } as Plugin;

  it("waits for filter state to initialize when an installed plugin loads", () => {
    expect(canLoadSourceListing(demo, undefined, demo.id, true)).toBe(false);
    expect(canLoadSourceListing(demo, demo, demo.id, true)).toBe(true);
  });

  it("keeps empty-string picker defaults in the initialized filter payload", () => {
    const schema: Filters = {
      completion: {
        label: "Completion",
        options: [
          { label: "Incomplete", value: "" },
          { label: "Complete", value: "1" },
        ],
        type: FilterTypes.Picker,
        value: "",
      },
    };

    expect(emptySourceFilterValues(schema)).toEqual({
      completion: { type: FilterTypes.Picker, value: "" },
    });
  });
});
