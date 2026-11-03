import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  strings: {} as Record<string, string>,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) =>
      Object.entries(values).reduce(
        (message, [name, value]) => message.replace(`{${name}}`, String(value)),
        mocks.strings[key] ?? key,
      ),
  }),
}));

import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import { LibrarySearchSources } from "./LibrarySearchSources";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

async function render(empty: boolean, onClearFilters = vi.fn()) {
  function Probe() {
    tree = LibrarySearchSources({ empty, onClearFilters, query: "Dragon" });
    return null;
  }
  harness = mountBackNavigationHarness();
  await harness.render(<Probe />);
  return collectElements(tree);
}

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

it.each([en, ko])("ends library results with a search of every source for the query", async (strings) => {
  mocks.strings = strings;
  const elements = await render(false);
  const button = elements.find((element) => typeof element.props.onClick === "function")!;
  expect(button.props.children).toBe(strings["library.searchSources"].replace("{query}", "Dragon"));
  (button.props.onClick as () => void)();
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledWith({ search: { q: "Dragon", tab: "search" }, to: "/browse" });
});

it("makes the source search the main action when nothing in the library matches", async () => {
  mocks.strings = en;
  const onClearFilters = vi.fn();
  const elements = await render(true, onClearFilters);
  const state = elements.find((element) => element.props.action)!;
  const action = state.props.action as { label: string; onClick: () => void };
  const secondary = state.props.secondaryAction as { label: string; onClick: () => void };

  expect(action.label).toBe("Search sources for “Dragon”");
  action.onClick();
  expect(mocks.navigate).toHaveBeenCalledWith({ search: { q: "Dragon", tab: "search" }, to: "/browse" });
  expect(secondary.label).toBe(en["library.noMatches.clear"]);
  secondary.onClick();
  expect(onClearFilters).toHaveBeenCalledOnce();
});
