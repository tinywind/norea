import { Checkbox, TextInput } from "@mantine/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";
import type { LibraryNovelSummary } from "../../db/queries/novel";

const locale = vi.hoisted(() => ({ strings: {} as Record<string, string> }));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    locale: "en",
    t: (key: string) => locale.strings[key] ?? key,
  }),
}));
vi.mock("../ui/ResponsiveSheet", () => ({
  ResponsiveSheet: ({
    children,
    opened,
    title,
  }: {
    children?: ReactNode;
    opened?: boolean;
    title?: ReactNode;
  }) => (opened ? <section aria-label={String(title ?? "")}>{children}</section> : null),
}));

import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import { useLibraryStore } from "../../store/library";
import { FilterOptions, LibraryViewOptions } from "./LibraryViewOptions";

const counts: LibraryNovelSummary = {
  completeNovels: 2,
  downloadedChapters: 5,
  downloadedNovels: 3,
  lastUpdatedAt: null,
  localNovels: 1,
  repairNeededNovels: 0,
  totalChapters: 20,
  totalNovels: 6,
  unreadChapters: 12,
  unreadNovels: 4,
};

let harness: BackNavigationHarness | undefined;
let rendered: ReactNode;
let renderedSheet: ReactNode;

function OptionsProbe({
  statuses = [
    { status: "Completed", totalNovels: 3 },
    { status: "Ongoing", totalNovels: 2 },
    { status: "On Hiatus", totalNovels: 1 },
  ],
  tags = [
    { tag: "Fantasy", totalNovels: 4 },
    { tag: "Romance", totalNovels: 2 },
  ],
}: {
  statuses?: Array<{ status: string; totalNovels: number }>;
  tags?: Array<{ tag: string; totalNovels: number }>;
}) {
  rendered = FilterOptions({
    activeSourceId: null,
    counts,
    onSourceChange: vi.fn(),
    sources: [],
    sourcesLoading: false,
    statuses,
    statusesLoading: false,
    tags,
    tagsLoading: false,
  });
  return null;
}

function SheetProbe() {
  renderedSheet = LibraryViewOptions({
    activeSourceId: null,
    counts,
    onClose: vi.fn(),
    onSourceChange: vi.fn(),
    onTabChange: vi.fn(),
    opened: true,
    sources: [],
    sourcesLoading: false,
    statuses: [],
    statusesLoading: false,
    tab: "filter",
    tags: [],
    tagsLoading: false,
  });
  return null;
}

beforeEach(() => {
  locale.strings = en;
  useLibraryStore.getState().clearFilters();
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

describe("LibraryViewOptions", () => {
  it("distinguishes finished-reading checkbox from publication Completed status in en and ko", () => {
    expect(en["library.filter.completed"]).toBe("Finished reading");
    expect(en["novel.status.completed"]).toBe("Completed");
    expect(ko["library.filter.completed"]).toBe("\uB2E4 \uC77D\uC74C");
    expect(ko["novel.status.completed"]).toBe("\uC644\uACB0");
    expect(ko["library.filter.completed"]).not.toBe(ko["novel.status.completed"]);
  });

  it("keeps the tabbed ResponsiveSheet marker class", async () => {
    harness = mountBackNavigationHarness();
    await harness.render(<SheetProbe />);

    const sheet = renderedSheet as { props?: { className?: string } };
    expect(sheet.props?.className).toBe("norea-library-view-options norea-sheet--tabbed");
  });

  it("supports multi-select publication status and searchable tag filtering", async () => {
    harness = mountBackNavigationHarness();
    await harness.render(<OptionsProbe />);

    const statusGroup = collectElements(rendered).find(
      (el) => el.type === Checkbox.Group && el.props.label === en["library.statusFilters.title"],
    )!;
    expect(statusGroup).toBeDefined();

    await harness.run(() => {
      (statusGroup.props.onChange as (values: string[]) => void)(["Completed", "On Hiatus"]);
    });
    expect(useLibraryStore.getState().selectedStatuses).toEqual(["Completed", "On Hiatus"]);

    const tagSearch = collectElements(rendered).find((el) => el.type === TextInput)!;
    await harness.run(() => {
      (tagSearch.props.onChange as (e: { currentTarget: { value: string } }) => void)({
        currentTarget: { value: "rom" },
      });
    });

    const visibleCheckboxes = collectElements(rendered).filter((el) => el.type === Checkbox);
    const visibleLabels = visibleCheckboxes.map((checkbox) => {
      const label = checkbox.props.label as { props?: { children?: Array<{ props?: { children?: string } }> } };
      return label?.props?.children?.[0]?.props?.children ?? String(checkbox.props.value ?? "");
    });
    expect(visibleLabels).toContain("Romance");
    expect(visibleLabels).not.toContain("Fantasy");

    const romanceCheckbox = visibleCheckboxes.find((checkbox) => {
      const label = checkbox.props.label as { props?: { children?: Array<{ props?: { children?: string } }> } };
      return label?.props?.children?.[0]?.props?.children === "Romance";
    })!;
    await harness.run(() => {
      (romanceCheckbox.props.onChange as () => void)();
    });
    expect(useLibraryStore.getState().selectedTags).toEqual(["Romance"]);
  });
});
