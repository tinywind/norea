import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";

const locale = vi.hoisted(() => ({ strings: {} as Record<string, string> }));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) =>
      Object.entries(values).reduce(
        (message, [name, value]) => message.replace(`{${name}}`, String(value)),
        locale.strings[key] ?? key,
      ),
  }),
}));

import { Radio } from "@mantine/core";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import type { ServerWorkFilter } from "../../lib/content-sync/browse";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { ServerBrowseFilters } from "./ServerBrowseFilters";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;
const onChange = vi.fn();
const sources = [{ id: "source-a", workCount: 1200 }, { id: "source-b", workCount: 3 }];

function Probe({ filter }: { filter: Pick<ServerWorkFilter, "completion" | "source"> }) {
  tree = ServerBrowseFilters({ filter, onChange, sourceName: id => id === "source-a" ? "Source A" : id, sources, sourcesLoading: false });
  return null;
}

async function render(filter: Pick<ServerWorkFilter, "completion" | "source"> = { completion: "", source: "" }) {
  harness = mountBackNavigationHarness();
  await harness.render(<Probe filter={filter} />);
  const elements = collectElements(tree);
  return {
    chip: (label: string) => elements.filter(element => element.props.children === label),
    elements,
  };
}

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

beforeEach(() => onChange.mockClear());

it.each([en, ko])("offers Completed and Ongoing as pressable chips beside the filter sheet, without Clear when nothing is filtered", async (strings) => {
  locale.strings = strings;
  const { chip } = await render();
  expect(chip(strings["contentSync.filters.completed"])[0]!.props.selected).toBe(false);
  expect(chip(strings["contentSync.filters.ongoing"])[0]!.props.selected).toBe(false);
  expect(chip(strings["contentSync.filters.more"])).toHaveLength(1);
  expect(chip(strings["common.clear"])).toHaveLength(0);
  (chip(strings["contentSync.filters.completed"])[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ completion: "completed" });
});

it.each([en, ko])("counts the completion and source filters, toggles a chip off and clears both", async (strings) => {
  locale.strings = strings;
  const { chip } = await render({ completion: "ongoing", source: "source-a" });
  expect(chip(strings["contentSync.filters.ongoing"])[0]!.props.selected).toBe(true);
  expect(chip(strings["contentSync.filters.moreActive"].replace("{count}", "2"))).toHaveLength(1);
  (chip(strings["contentSync.filters.ongoing"])[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ completion: "" });
  (chip(strings["common.clear"])[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ completion: "", source: "" });
});

it("lists completion and every source with its work count in the filter sheet, like the library", async () => {
  locale.strings = en;
  const { elements } = await render({ completion: "completed", source: "" });
  const sheet = elements.find(element => element.type === ResponsiveSheet)!;
  expect(sheet.props.className).toBe("norea-library-view-options");
  const groups = collectElements(sheet.props.children as ReactNode).filter(element => element.type === Radio.Group);
  expect(groups.map(group => [group.props.label, group.props.value])).toEqual([[en["contentSync.filters.completion"], "completed"], [en["contentSync.sourceFilter"], ""]]);
  const radios = (group: ReactElement<Record<string, unknown>>) => collectElements(group.props.children as ReactNode).filter(element => element.type === Radio);
  expect(radios(groups[0]!).map(radio => radio.props.value)).toEqual(["", "completed", "ongoing"]);
  const sourceRadios = radios(groups[1]!);
  expect(sourceRadios.map(radio => radio.props.value)).toEqual(["", "source-a", "source-b"]);
  const counts = collectElements(sourceRadios[1]!.props.label as ReactNode).filter(element => element.props.className === "norea-library-option-count");
  expect(counts[0]!.props.children).toBe((1200).toLocaleString());
  (groups[1]!.props.onChange as (value: string) => void)("source-b");
  expect(onChange).toHaveBeenLastCalledWith({ source: "source-b" });
  (groups[0]!.props.onChange as (value: string) => void)("ongoing");
  expect(onChange).toHaveBeenLastCalledWith({ completion: "ongoing" });
});
