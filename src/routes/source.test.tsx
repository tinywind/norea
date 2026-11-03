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
    queryKey[1] === "installed" ? { data: mocks.plugins, isLoading: false } : mocks.listing,
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
const { BlockingLoadingOverlay, StateView } = await import("../components/AppFrame");
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
  it("shows the source name in the app bar and keeps rare actions in the overflow", async () => {
    const elements = await mountPage();
    expect(elements.find((element) => element.type === "h1")!.props.children).toBe("Demo Source");
    const menu = elements.find((element) => Array.isArray(element.props.items))!;
    expect((menu.props.items as { label: string }[]).map((item) => item.label)).toEqual([
      "common.openSite",
      "source.readerSettings",
    ]);
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
