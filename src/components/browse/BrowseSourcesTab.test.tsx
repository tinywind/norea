import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "../../lib/plugins/types";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  plugins: [] as Plugin[],
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => ({ data: mocks.plugins, error: null, isLoading: false }),
}));
vi.mock("../../i18n", () => ({
  formatPluginLanguageForLocale: (_locale: string, lang: string) => lang,
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../ui/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../lib/plugins/manager", () => ({ isValidPluginItem: () => true, pluginManager: {} }));

import { BrowseSourcesTab, groupSources } from "./BrowseSourcesTab";

function plugin(id: string, lang = "en"): Plugin {
  return { id, name: id, lang, version: "1", url: "", iconUrl: "", apiVersion: "0.2", getBaseUrl: () => "https://x" } as Plugin;
}

let harness: BackNavigationHarness | undefined;
let tree: ReturnType<typeof BrowseSourcesTab> | undefined;

beforeEach(() => {
  mocks.plugins = [plugin("alpha"), plugin("beta")];
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

async function mountTab() {
  function Probe() {
    tree = BrowseSourcesTab({ active: true });
    return null;
  }
  harness = mountBackNavigationHarness();
  await harness.render(<Probe />);
  return collectElements(tree);
}

type MenuItem = { label: string; onClick: () => void };

it("opens the source when its row is tapped", async () => {
  const rows = (await mountTab()).filter((element) => typeof element.props.onOpen === "function");
  (rows[0]!.props.onOpen as () => void)();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/source", search: { pluginId: "alpha", query: "" } });
});

it("manages a source in Extensions from its row overflow, without an uninstall action", async () => {
  const row = (await mountTab()).find((element) => Array.isArray(element.props.menuItems))!;
  const items = row.props.menuItems as MenuItem[];
  expect(items.map((item) => item.label)).not.toContain("browse.uninstall");
  items.find((item) => item.label === "browse.sources.manage")!.onClick();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/browse/extensions", search: { plugin: "alpha" } });
});

it("offers a name filter only above eight sources", async () => {
  const hasFilter = (elements: Awaited<ReturnType<typeof mountTab>>) =>
    elements.some((element) => element.props["aria-label"] === "browse.sources.filter");
  expect(hasFilter(await mountTab())).toBe(false);
  await harness!.unmount();
  mocks.plugins = Array.from({ length: 9 }, (_, index) => plugin(`p${index}`));
  expect(hasFilter(await mountTab())).toBe(true);
});

const plugins = [plugin("Zeta", "en"), plugin("Alpha", "ko"), plugin("Beta", "en"), plugin("Gamma", "ja")];

describe("groupSources", () => {
  it("lists pinned sources first and keeps them out of their language group", () => {
    const { pinned, groups } = groupSources(plugins, ["Zeta"], [], "en");

    expect(pinned.map((entry) => entry.id)).toEqual(["Zeta"]);
    expect(groups.map(({ lang, plugins: rows }) => [lang, rows.map((row) => row.id)])).toEqual([
      ["en", ["Beta"]],
      ["ja", ["Gamma"]],
      ["ko", ["Alpha"]],
    ]);
  });

  it("shows only the languages the persisted filter selects, pinned sources included", () => {
    const { pinned, groups } = groupSources(plugins, ["Alpha"], ["en"], "en");

    expect(pinned).toEqual([]);
    expect(groups.map(({ lang }) => lang)).toEqual(["en"]);
  });
});
