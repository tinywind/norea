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
  listingEnabled: undefined as boolean | undefined,
  navigate: vi.fn(),
  open: { error: null, isPending: false, mutate: vi.fn() } as Record<string, unknown>,
  plugins: [] as unknown[],
  recovery: { failedAttempts: 0, lastError: null as string | null },
  recoveryStopped: false,
  requestRecovery: vi.fn(),
  vpnStatus: { data: undefined, error: null, refetch: vi.fn() } as Record<string, unknown>,
  workCategories: [] as Array<{ pluginId: string; novelPath: string; categories: string[] }>,
}));

vi.mock("../components/PdfReaderContent", () => ({ PdfReaderContent: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: () => "/source?pluginId=demo",
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => mocks.open,
  useQuery: ({ enabled, queryKey }: { enabled?: boolean; queryKey: unknown[] }) => {
    if (queryKey[1] === "installed") return { data: mocks.plugins, isLoading: false };
    if (queryKey[0] === "novel") return { data: [] };
    if (queryKey[0] === "category") return { data: mocks.workCategories };
    if (queryKey[0] === "plugin-vpn") return mocks.vpnStatus;
    mocks.listingEnabled = enabled;
    return mocks.listing;
  },
  useQueryClient: () => ({ cancelQueries: vi.fn(), invalidateQueries: vi.fn() }),
}));
vi.mock("../lib/plugin-vpn", async (original) => ({
  ...(await original<typeof import("../lib/plugin-vpn")>()),
  isPluginVpnRecoveryStopped: () => mocks.recoveryStopped,
}));
vi.mock("../lib/plugin-vpn-lifecycle", async (original) => ({
  ...(await original<typeof import("../lib/plugin-vpn-lifecycle")>()),
  getPluginVpnRecoverySnapshot: () => mocks.recovery,
  requestPluginVpnRecovery: () => mocks.requestRecovery(),
  subscribePluginVpnRecovery: () => () => undefined,
}));
vi.mock("../i18n", async (original) => ({
  ...(await original<typeof import("../i18n")>()),
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../lib/tasks/scheduler", async (original) => ({
  ...(await original<typeof import("../lib/tasks/scheduler")>()),
  taskScheduler: { cancel: mocks.cancel },
}));

const { canLoadSourceListing, resolveSourcePluginVpnNotice, SourcePage } = await import("./source");
const { BlockingLoadingOverlay, PageHeader, StateView } = await import("../components/AppFrame");
const { CoverGridSkeleton } = await import("../components/browse/CoverGridSkeleton");
const { SourceDisplaySheet } = await import("../components/browse/SourceDisplaySheet");
const { PluginFilters } = await import("../components/PluginFilters");
const { ResponsiveSheet } = await import("../components/ui/ResponsiveSheet");
const { useNetworkStore } = await import("../lib/network");
const { PluginVpnUnavailableError } = await import("../lib/plugin-vpn-traffic");
const { DEFAULT_SOURCE_DISPLAY_MODE, DEFAULT_SOURCE_NOVELS_PER_ROW, useBrowseStore } = await import("../store/browse");
const { usePluginVpnStore } = await import("../store/plugin-vpn");

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
  useBrowseStore.setState({
    sourceDisplayMode: DEFAULT_SOURCE_DISPLAY_MODE,
    sourceNovelsPerRow: DEFAULT_SOURCE_NOVELS_PER_ROW,
  });
  usePluginVpnStore.getState().setEnabled(false);
  useNetworkStore.setState({ connectivity: "online", revision: 1 });
  mocks.plugins = [plugin(genreFilters)];
  mocks.listing = { data: undefined, error: null, isFetching: true, refetch: vi.fn() };
  mocks.listingEnabled = undefined;
  mocks.open = { error: null, isPending: false, mutate: vi.fn() };
  mocks.recovery = { failedAttempts: 0, lastError: null };
  mocks.recoveryStopped = false;
  mocks.vpnStatus = { data: undefined, error: null, refetch: vi.fn() };
  mocks.workCategories = [];
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

const menuItems = (elements: ReactElement<Record<string, unknown>>[]) =>
  elements.find(element => Array.isArray(element.props.items))!.props.items as { label: string; onClick: () => void }[];

describe("SourcePage", () => {
  it("opens reader settings from the source menu without plugin options", async () => {
    const elements = await mountPage();
    const header = elements.find((element) => element.type === PageHeader)!;
    expect(header.props.title).toBe("Demo Source");
    expect(header.props.onBack).toEqual(expect.any(Function));
    expect(menuItems(elements).some(item => item.label === "common.openSite")).toBe(true);
    await harness!.run(() => menuItems(elements).find(item => item.label === "source.readerSettings")!.onClick());
    const panel = collectElements(tree).find((element) => element.props.target !== undefined);
    expect(panel!.props.target).toEqual({ kind: "source", sourceId: "demo", label: "Demo Source" });
  });

  it("keeps display in the header and both source settings choices in the menu", async () => {
    mocks.plugins = [{ ...plugin(), pluginSettings: { token: { type: "Text", label: "Token", value: "" } } } as unknown as Plugin];
    const elements = await mountPage();
    expect(menuItems(elements).some(item => item.label === "common.openSite")).toBe(true);
    const items = menuItems(elements);
    expect(labelled(elements, "library.viewOptions.display")).toBeDefined();
    expect(items.map((item) => item.label)).toEqual(["common.openSite", "source.sourceSettings", "source.readerSettings"]);
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

  it("renders cached first-page results immediately on the first render without a skeleton flash", async () => {
    mocks.plugins = [plugin()];
    mocks.listing = {
      data: { items: [{ name: "Cached Book", path: "/cached" }], page: 1, scopeKey: "filters||{}|demo" },
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    };
    const renders: ReactNode[] = [];
    function Probe() {
      const rendered = SourcePage({ pluginId: "demo", query: "" });
      renders.push(rendered);
      return null;
    }
    harness = mountBackNavigationHarness();
    await harness.render(<Probe />);
    const firstRenderElements = collectElements(renders[0]);
    expect(byType(firstRenderElements, CoverGridSkeleton)).toHaveLength(0);
    expect(
      firstRenderElements.some(
        (element) =>
          (element.props.item as { name?: string } | undefined)?.name === "Cached Book",
      ),
    ).toBe(true);
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

  it("shows the VPN failure status and Open network settings immediately instead of waiting on a skeleton when plugin VPN is reconnecting after a failure", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    mocks.recovery = {
      failedAttempts: 2,
      lastError: "OpenVPN connection failed (CONNECTION_TIMEOUT)",
    };
    mocks.vpnStatus = {
      data: {
        error: null,
        phase: "connecting",
        profile: {
          hash: "a".repeat(64),
          isVpnGateFinder: true,
          remoteHost: "175.213.14.118",
          requiresUsernamePassword: true,
        },
        proxyPort: 35785,
        supported: true,
      },
      error: null,
      refetch: vi.fn(),
    };

    const elements = await mountPage();
    expect(mocks.listingEnabled).toBe(false);
    expect(byType(elements, CoverGridSkeleton)).toHaveLength(0);

    const state = byType(elements, StateView)[0]!;
    const props = state.props as {
      action: { label: string; onClick: () => void };
      color: string;
      details: { content: string; label: string };
      message: string;
      secondaryAction: { label: string; onClick: () => void };
      title: string;
    };
    expect(props.color).toBe("danger");
    expect(props.title).toBe("source.vpnUnavailableTitle");
    expect(props.message).toBe("source.vpnRetryingServerMessage");
    expect(props.details.content).toBe("OpenVPN connection failed (CONNECTION_TIMEOUT)");
    expect(props.action.label).toBe("settings.data.pluginVpn.toast.openNetworkSettings");
    expect(props.secondaryAction.label).toBe("common.retry");

    props.action.onClick();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "network" },
    });

    props.secondaryAction.onClick();
    expect(mocks.requestRecovery).toHaveBeenCalledOnce();
    expect(mocks.vpnStatus.refetch).toHaveBeenCalledOnce();
  });

  it("loads the source listing normally once plugin VPN is connected", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    mocks.vpnStatus = {
      data: {
        error: null,
        phase: "connected",
        profile: {
          hash: "a".repeat(64),
          isVpnGateFinder: true,
          remoteHost: "175.213.14.118",
          requiresUsernamePassword: true,
        },
        proxyPort: 35785,
        supported: true,
      },
      error: null,
      refetch: vi.fn(),
    };

    const elements = await mountPage();
    expect(mocks.listingEnabled).toBe(true);
    expect(byType(elements, StateView)).toHaveLength(0);
    expect(byType(elements, CoverGridSkeleton)).toHaveLength(1);
  });

  it("offers Open network settings instead of Open site when a listing fails with PluginVpnUnavailableError", async () => {
    mocks.listing = {
      data: undefined,
      error: new PluginVpnUnavailableError(),
      isFetching: false,
      refetch: vi.fn(),
    };

    const state = byType(await mountPage(), StateView)[0]!;
    const props = state.props as {
      action: { label: string; onClick: () => void };
      secondaryAction: { label: string; onClick: () => void };
      title: string;
    };
    expect(props.title).toBe("source.vpnUnavailableTitle");
    expect(props.action.label).toBe("settings.data.pluginVpn.toast.openNetworkSettings");
    expect(props.secondaryAction.label).toBe("common.retry");

    props.action.onClick();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "network" },
    });
    props.secondaryAction.onClick();
    expect(mocks.listing.refetch).toHaveBeenCalledOnce();
  });

  it("resolves warning and exhausted VPN notices cleanly", () => {
    const t = (key: string) => key;
    const baseProfile = {
      hash: "a".repeat(64),
      isVpnGateFinder: true,
      remoteHost: "211.49.100.28",
      requiresUsernamePassword: true,
    };

    expect(
      resolveSourcePluginVpnNotice(
        {
          online: true,
          recovery: { failedAttempts: 0, lastError: null },
          recoveryStopped: false,
          status: { error: null, phase: "connecting", profile: baseProfile, proxyPort: 35785, supported: true },
          statusError: null,
          vpnEnabled: true,
        },
        t,
      ),
    ).toEqual({
      color: "warn",
      details: null,
      message: "source.vpnConnectingServerMessage",
      retryable: true,
      title: "source.vpnConnectingTitle",
    });

    expect(
      resolveSourcePluginVpnNotice(
        {
          online: true,
          recovery: { failedAttempts: 3, lastError: "OpenVPN connection failed (CONNECTION_TIMEOUT)" },
          recoveryStopped: true,
          status: { error: null, phase: "disabled", profile: null, proxyPort: 35785, supported: true },
          statusError: null,
          vpnEnabled: true,
        },
        t,
      ),
    ).toEqual({
      color: "danger",
      details: "OpenVPN connection failed (CONNECTION_TIMEOUT)",
      message: "settings.data.pluginVpn.toast.recoveryStoppedBody",
      retryable: false,
      title: "source.vpnUnavailableTitle",
    });
  });

  it("opens the source display sheet and renders catalog works with the persisted display mode, columns, and user categories", async () => {
    mocks.plugins = [plugin()];
    mocks.listing = {
      data: {
        items: [
          { name: "Categorized Book", path: "/cat-book" },
          { name: "Plain Book", path: "/plain-book" },
        ],
        page: 1,
        scopeKey: "filters||{}|demo",
      },
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    };
    mocks.workCategories = [
      { pluginId: "demo", novelPath: "/cat-book", categories: ["5 Stars", "Reading"] },
    ];

    useBrowseStore.setState({ sourceDisplayMode: "comfortable", sourceNovelsPerRow: 4 });
    let elements = await mountPage();

    const displayButton = labelled(elements, "library.viewOptions.display");
    expect(displayButton).toBeDefined();
    expect(byType(elements, SourceDisplaySheet)[0]!.props.opened).toBe(false);

    await harness!.run(() => (displayButton!.props.onClick as () => void)());
    elements = collectElements(tree);
    expect(byType(elements, SourceDisplaySheet)[0]!.props.opened).toBe(true);

    const grid = elements.find((element) => element.props.className === "norea-source-catalog-grid")!;
    expect(grid.props["data-mode"]).toBe("comfortable");
    expect(grid.props.style).toEqual({ "--norea-source-grid-columns": 4 });

    const novelCards = elements.filter((element) => (element.props.item as { path?: string } | undefined)?.path !== undefined);
    expect(novelCards).toHaveLength(2);
    expect(novelCards[0]!.props.categories).toEqual(["5 Stars", "Reading"]);
    expect(novelCards[0]!.props.displayMode).toBe("comfortable");
    expect(novelCards[1]!.props.categories).toEqual([]);

    await harness!.run(() => useBrowseStore.getState().setSourceDisplayMode("list"));
    elements = collectElements(tree);
    const list = elements.find((element) => element.props.className === "norea-source-catalog-list")!;
    expect(list.props["data-mode"]).toBe("list");
    const listCards = elements.filter((element) => (element.props.item as { path?: string } | undefined)?.path !== undefined);
    expect(listCards[0]!.props.displayMode).toBe("list");
    expect(listCards[0]!.props.categories).toEqual(["5 Stars", "Reading"]);
  });

  it("updates source display mode and column count from SourceDisplaySheet and disables column steppers in list mode", async () => {
    function SheetProbe() {
      tree = SourceDisplaySheet({ onClose: vi.fn(), opened: true });
      return null;
    }
    harness = mountBackNavigationHarness();
    await harness.render(<SheetProbe />);

    let elements = collectElements(tree);
    const radioGroup = elements.find((element) => element.props.label === "librarySettings.displayMode")!;
    const fewer = labelled(elements, "library.viewOptions.fewerColumns")!;
    const more = labelled(elements, "library.viewOptions.moreColumns")!;

    expect(radioGroup.props.value).toBe("comfortable");
    expect(fewer.props.disabled).toBe(false);
    expect(more.props.disabled).toBe(false);

    await harness.run(() => (more.props.onClick as () => void)());
    expect(useBrowseStore.getState().sourceNovelsPerRow).toBe(4);

    await harness.run(() => (radioGroup.props.onChange as (value: string) => void)("list"));
    elements = collectElements(tree);
    expect(useBrowseStore.getState().sourceDisplayMode).toBe("list");
    expect(labelled(elements, "library.viewOptions.fewerColumns")!.props.disabled).toBe(true);
    expect(labelled(elements, "library.viewOptions.moreColumns")!.props.disabled).toBe(true);
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
