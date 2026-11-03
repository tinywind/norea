import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";
import type { LibraryNovelSummary } from "../../db/queries/novel";

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

import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import { useLibraryStore } from "../../store/library";
import { LibraryQuickFilters } from "./LibraryQuickFilters";

const counts: LibraryNovelSummary = {
  completeNovels: 1, downloadedChapters: 0, downloadedNovels: 2, lastUpdatedAt: null, localNovels: 0,
  repairNeededNovels: 0, totalChapters: 0, totalNovels: 4, unreadChapters: 0, unreadNovels: 3,
};

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

function ChipsProbe({ sourceActive }: { sourceActive: boolean }) {
  tree = LibraryQuickFilters({ counts, onClear: vi.fn(), onOpenFilters: vi.fn(), sourceActive });
  return null;
}

async function render(sourceActive = false) {
  harness = mountBackNavigationHarness();
  await harness.render(<ChipsProbe sourceActive={sourceActive} />);
  return (label: string) => collectElements(tree).filter((element) => element.props.children === label);
}

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

beforeEach(() => {
  useLibraryStore.getState().clearFilters();
});

it.each([en, ko])("offers Unread and Downloaded as pressable chips without Clear when nothing is filtered", async (strings) => {
  locale.strings = strings;
  const chip = await render();
  expect(chip(strings["library.filter.unread"])[0]!.props["aria-pressed"]).toBe(false);
  expect(chip(strings["library.filter.downloaded"])[0]!.props["aria-pressed"]).toBe(false);
  expect(chip(strings["library.filter.more"])).toHaveLength(1);
  expect(chip(strings["common.clear"])).toHaveLength(0);
});

it.each([en, ko])("counts every active filter, including the source, and offers Clear", async (strings) => {
  locale.strings = strings;
  useLibraryStore.getState().setUnreadOnlyMode(true);
  useLibraryStore.getState().setLocalOnlyMode(true);
  const chip = await render(true);
  expect(chip(strings["library.filter.unread"])[0]!.props["aria-pressed"]).toBe(true);
  expect(chip(strings["library.filter.moreActive"].replace("{count}", "3"))).toHaveLength(1);
  expect(chip(strings["common.clear"])).toHaveLength(1);
});
