import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { LibraryCategory } from "../../db/queries/category";

vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) =>
      Object.entries(values).reduce((message, [, value]) => `${message}:${String(value)}`, key),
  }),
}));

import { collectElements, mountBackNavigationHarness } from "../../lib/android-back-navigation.test-support";
import {
  applyCategoryOrder,
  categoryDndId,
  CategoryList,
  CategoryTabs,
  getLibraryCategoryEntries,
  parseCategoryDndId,
  reorderCategoryIds,
  type LibraryCategoryEntry,
} from "./LibraryCategories";

const categories: LibraryCategory[] = [
  { id: 1, name: "Default", sort: 0, isSystem: true, novelCount: 2 },
  { id: 4, name: "Reading", sort: 1, isSystem: false, novelCount: 8 },
];
const entries = getLibraryCategoryEntries(categories, { all: 120, uncategorized: 4 }, (key) => key);

it("orders All, the user's categories and Uncategorized, each with its count", () => {
  expect(entries.map((entry) => [entry.label, entry.count])).toEqual([
    ["categories.all", 120], ["Default", 2], ["Reading", 8], ["categories.uncategorized", 4],
  ]);
});

it("marks only the active category tab as pressed", () => {
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <CategoryTabs activeId={4} entries={entries} onSelect={vi.fn()} />
    </MantineProvider>,
  ));
  const pressed = $("button[aria-pressed=true]");
  expect(pressed).toHaveLength(1);
  expect(pressed.text()).toBe("Reading8");
  expect($("button")).toHaveLength(4);
});

it("offers rename and delete only for categories the user created, beside the row button", () => {
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <CategoryList
        activeId={null} entries={entries} error={new Error("SQLITE_BUSY")} loading={false}
        onCreate={vi.fn()} onDelete={vi.fn()} onRename={vi.fn()} onSelect={vi.fn()}
      />
    </MantineProvider>,
  ));
  expect($("button[aria-label^='categories.actionsFor']").map((_, button) => $(button).attr("aria-label")).get())
    .toEqual(["categories.actionsFor:Reading"]);
  expect($("button button")).toHaveLength(0);
  expect($("button[aria-current=true]").text()).toBe("categories.all120");
  expect($("[role=alert]").text()).toBe("categories.loadFailed");
  expect($("[role=alert]").text()).not.toContain("SQLITE_BUSY");
  expect($("button[aria-label^='categories.reorderFor']")).toHaveLength(0);
});

it("adds drag handles and reorder controls only for multiple manual categories without nesting buttons", () => {
  const multipleCategories: LibraryCategory[] = [
    { id: 1, name: "Default", sort: 0, isSystem: true, novelCount: 2 },
    { id: 4, name: "Reading", sort: 1, isSystem: false, novelCount: 8 },
    { id: 7, name: "Completed", sort: 2, isSystem: false, novelCount: 3 },
  ];
  const multipleEntries = getLibraryCategoryEntries(
    multipleCategories,
    { all: 120, uncategorized: 4 },
    (key) => key,
  );
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <CategoryList
        activeId={4}
        entries={multipleEntries}
        error={null}
        loading={false}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
      />
    </MantineProvider>,
  ));

  expect(
    $("button[aria-label^='categories.reorderFor']")
      .map((_, button) => $(button).attr("aria-label"))
      .get(),
  ).toEqual(["categories.reorderFor:Reading", "categories.reorderFor:Completed"]);
  expect($("li[data-sortable='true']")).toHaveLength(2);
  expect($("button button")).toHaveLength(0);
});

it("disables category drag handles while a reorder mutation is pending", () => {
  const multipleCategories: LibraryCategory[] = [
    { id: 4, name: "Reading", sort: 0, isSystem: false, novelCount: 8 },
    { id: 7, name: "Completed", sort: 1, isSystem: false, novelCount: 3 },
  ];
  const multipleEntries = getLibraryCategoryEntries(
    multipleCategories,
    { all: 11, uncategorized: 0 },
    (key) => key,
  );
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <CategoryList
        activeId={null}
        entries={multipleEntries}
        error={null}
        loading={false}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        reordering
      />
    </MantineProvider>,
  ));

  const handles = $("button[aria-label^='categories.reorderFor']");
  expect(handles).toHaveLength(2);
  expect(handles.filter((_, button) => Boolean($(button).prop("disabled")))).toHaveLength(2);
});

it("computes drag ids, reorder results, and optimistic category order while preserving system categories", () => {
  expect(categoryDndId(12)).toBe("category:12");
  expect(parseCategoryDndId("category:12")).toBe(12);
  expect(parseCategoryDndId("category:0")).toBeNull();
  expect(parseCategoryDndId("category:-1")).toBeNull();
  expect(parseCategoryDndId("chapter:12")).toBeNull();

  expect(reorderCategoryIds([4, 7, 9], 9, 4)).toEqual([9, 4, 7]);
  expect(reorderCategoryIds([4, 7, 9], 4, 4)).toBeNull();
  expect(reorderCategoryIds([4, 7, 9], 99, 4)).toBeNull();

  const mixed: LibraryCategory[] = [
    { id: 1, name: "Default", sort: 0, isSystem: true, novelCount: 2 },
    { id: 4, name: "Reading", sort: 1, isSystem: false, novelCount: 8 },
    { id: 7, name: "Completed", sort: 2, isSystem: false, novelCount: 3 },
    { id: 9, name: "Favorites", sort: 3, isSystem: false, novelCount: 5 },
  ];
  expect(
    applyCategoryOrder(mixed, [9, 4, 7]).map(({ id, name, sort, isSystem }) => ({
      id,
      name,
      sort,
      isSystem,
    })),
  ).toEqual([
    { id: 1, name: "Default", sort: 0, isSystem: true },
    { id: 9, name: "Favorites", sort: 1, isSystem: false },
    { id: 4, name: "Reading", sort: 2, isSystem: false },
    { id: 7, name: "Completed", sort: 3, isSystem: false },
  ]);
  expect(applyCategoryOrder(mixed, [9, 4])).toEqual(mixed);
});

it("invokes onReorder on drag end and overflow move actions", async () => {
  const harness = mountBackNavigationHarness();
  const multipleCategories: LibraryCategory[] = [
    { id: 4, name: "Reading", sort: 0, isSystem: false, novelCount: 8 },
    { id: 7, name: "Completed", sort: 1, isSystem: false, novelCount: 3 },
    { id: 9, name: "Favorites", sort: 2, isSystem: false, novelCount: 5 },
  ];
  const multipleEntries = getLibraryCategoryEntries(
    multipleCategories,
    { all: 16, uncategorized: 0 },
    (key) => key,
  );
  const onReorder = vi.fn();
  let tree: ReturnType<typeof CategoryList>;

  function Probe() {
    tree = CategoryList({
      activeId: null,
      entries: multipleEntries,
      error: null,
      loading: false,
      onCreate: vi.fn(),
      onDelete: vi.fn(),
      onRename: vi.fn(),
      onReorder,
      onSelect: vi.fn(),
    });
    return null;
  }

  try {
    await harness.render(<Probe />);
    const dndContext = collectElements(tree!).find(
      (element) => typeof element.props.onDragEnd === "function",
    );
    expect(dndContext).toBeDefined();
    (dndContext!.props.onDragEnd as (event: unknown) => void)({
      active: { id: "category:9" },
      over: { id: "category:4" },
    });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith([9, 4, 7]);

    onReorder.mockClear();
    (dndContext!.props.onDragEnd as (event: unknown) => void)({
      active: { id: "category:4" },
      over: { id: "category:4" },
    });
    expect(onReorder).not.toHaveBeenCalled();

    const rows = collectElements(tree!).filter(
      (element) =>
        typeof element.props.reorder === "object" &&
        element.props.reorder !== null,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]!.props.reorder).toMatchObject({
      canMoveUp: false,
      canMoveDown: true,
    });
    expect(rows[2]!.props.reorder).toMatchObject({
      canMoveUp: true,
      canMoveDown: false,
    });
    (rows[0]!.props.reorder as { onMoveDown: () => void }).onMoveDown();
    expect(onReorder).toHaveBeenCalledExactlyOnceWith([7, 4, 9]);

    onReorder.mockClear();
    (rows[2]!.props.reorder as { onMoveUp: () => void }).onMoveUp();
    expect(onReorder).toHaveBeenCalledExactlyOnceWith([4, 9, 7]);
  } finally {
    await harness.unmount();
  }
});

function categoryTabsHarness() {
  const harness = mountBackNavigationHarness();
  const scrollBy = vi.fn();
  const scrollIntoView = vi.fn();
  let wheelListener: ((event: WheelEvent) => void) | undefined;
  let wheelOptions: boolean | AddEventListenerOptions | undefined;
  const addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "wheel" && typeof listener === "function") {
        wheelListener = listener as (event: WheelEvent) => void;
        wheelOptions = options;
      }
    },
  );
  const removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "wheel" && listener === wheelListener) {
      wheelListener = undefined;
    }
  });
  let bounds = { left: 280, right: 400 };
  let scrollWidth = 480;
  let scrollLeft = 0;
  const capturedPointers = new Set<number>();
  const dataset: Record<string, string | undefined> = {};
  const setPointerCapture = vi.fn((pointerId: number) => {
    capturedPointers.add(pointerId);
  });
  const releasePointerCapture = vi.fn((pointerId: number) => {
    capturedPointers.delete(pointerId);
  });
  const hasPointerCapture = vi.fn((pointerId: number) => capturedPointers.has(pointerId));
  const tab = { getBoundingClientRect: () => bounds, scrollIntoView } as unknown as HTMLButtonElement;
  const strip = {
    addEventListener,
    clientLeft: 0,
    clientWidth: 160,
    dataset,
    getBoundingClientRect: () => ({ left: 100 }),
    hasPointerCapture,
    releasePointerCapture,
    removeEventListener,
    scrollBy,
    get scrollLeft() {
      return scrollLeft;
    },
    set scrollLeft(value: number) {
      scrollLeft = value;
    },
    get scrollWidth() {
      return scrollWidth;
    },
    setPointerCapture,
  };
  let resize: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  let tree: ReturnType<typeof CategoryTabs>;
  const onSelect = vi.fn();
  function Probe({ activeId, values }: { activeId: number | null; values: readonly LibraryCategoryEntry[] }) {
    tree = CategoryTabs({ activeId, entries: values, onSelect });
    (tree.props.ref as { current: unknown }).current = strip;
    const active = collectElements(tree).find((element) => element.props["aria-pressed"] === true);
    if (active) (active.props.ref as { current: unknown }).current = tab;
    return null;
  }
  const buttons = () => collectElements(tree).filter((element) => "aria-pressed" in element.props);
  return {
    addEventListener,
    dataset,
    getScrollLeft: () => scrollLeft,
    getWheelListener: () => wheelListener,
    getWheelOptions: () => wheelOptions,
    hasPointerCapture,
    onSelect,
    releasePointerCapture,
    removeEventListener,
    scrollBy,
    scrollIntoView,
    setPointerCapture,
    render: (activeId: number | null, values = entries) => harness.render(<Probe activeId={activeId} values={values} />),
    resize: () => resize?.(),
    setBounds: (left: number, right: number) => { bounds = { left, right }; },
    setScrollLeft: (value: number) => { scrollLeft = value; },
    setScrollWidth: (width: number) => { scrollWidth = width; },
    pointerDown: (init: Partial<PointerEvent>) => {
      (tree.props.onPointerDown as (event: Partial<PointerEvent>) => void)({
        button: 0,
        buttons: 1,
        clientX: 120,
        pointerId: 1,
        pointerType: "mouse",
        ...init,
      });
    },
    pointerMove: (init: Partial<PointerEvent>) => {
      (tree.props.onPointerMove as (event: Partial<PointerEvent>) => void)({
        buttons: 1,
        clientX: 120,
        pointerId: 1,
        pointerType: "mouse",
        ...init,
      });
    },
    pointerUp: (init: Partial<PointerEvent> = {}) => {
      (tree.props.onPointerUp as (event: Partial<PointerEvent>) => void)({
        button: 0,
        buttons: 0,
        clientX: 120,
        pointerId: 1,
        pointerType: "mouse",
        ...init,
      });
    },
    pointerCancel: () => {
      (tree.props.onPointerCancel as () => void)();
    },
    clickCapture: () => {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      (tree.props.onClickCapture as (event: { preventDefault: () => void; stopPropagation: () => void }) => void)({
        preventDefault,
        stopPropagation,
      });
      return { preventDefault, stopPropagation };
    },
    dragStart: () => {
      const preventDefault = vi.fn();
      (tree.props.onDragStart as (event: { preventDefault: () => void }) => void)({ preventDefault });
      return preventDefault;
    },
    wheel: (init: Partial<WheelEvent>) => {
      const preventDefault = vi.fn();
      wheelListener?.({
        ctrlKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 0,
        preventDefault,
        ...init,
      } as unknown as WheelEvent);
      return preventDefault;
    },
    focusFirst: () => (buttons()[0]!.props.onFocus as (event: { currentTarget: HTMLButtonElement }) => void)({ currentTarget: tab }),
    selectLast: () => (buttons().at(-1)!.props.onClick as () => void)(),
    unmount: harness.unmount,
  };
}

it("reveals active and keyboard-focused categories by moving only their horizontal strip", async () => {
  const harness = categoryTabsHarness();
  try {
    await harness.render(4);
    expect(harness.scrollBy).toHaveBeenLastCalledWith({ left: 140 });
    expect(harness.scrollIntoView).not.toHaveBeenCalled();

    harness.scrollBy.mockClear();
    harness.setBounds(140, 230);
    harness.resize();
    expect(harness.scrollBy).not.toHaveBeenCalled();
    harness.setBounds(70, 180);
    harness.resize();
    expect(harness.scrollBy).toHaveBeenLastCalledWith({ left: -30 });

    harness.setBounds(280, 400);
    harness.focusFirst();
    expect(harness.scrollBy).toHaveBeenLastCalledWith({ left: 140 });
    expect(harness.onSelect).not.toHaveBeenCalled();
    expect(harness.scrollIntoView).not.toHaveBeenCalled();
  } finally {
    await harness.unmount();
  }
});

it("reveals a restored last category after its entries load and preserves its selection callback", async () => {
  const harness = categoryTabsHarness();
  const manyEntries = [...entries, ...Array.from({ length: 6 }, (_, index) => ({
    id: index + 10, count: index, label: `Category ${index + 10}`,
  }))];
  try {
    await harness.render(15);
    expect(harness.scrollBy).not.toHaveBeenCalled();
    await harness.render(15, manyEntries);
    expect(harness.scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 140 });
    harness.selectLast();
    expect(harness.onSelect).toHaveBeenCalledExactlyOnceWith(15);

    harness.scrollBy.mockClear();
    await harness.render(15, manyEntries.map((entry) => ({ ...entry, count: entry.count + 1 })));
    expect(harness.scrollBy).not.toHaveBeenCalled();
  } finally {
    await harness.unmount();
  }
});

it("scrolls category tabs horizontally on vertical mouse wheel in pixel, line, and page modes", async () => {
  const harness = categoryTabsHarness();
  try {
    await harness.render(null);
    const registeredListener = harness.getWheelListener();
    expect(registeredListener).toBeTypeOf("function");
    expect(harness.addEventListener).toHaveBeenCalledWith("wheel", registeredListener, { passive: false });
    expect(harness.getWheelOptions()).toEqual({ passive: false });

    harness.scrollBy.mockClear();
    const pixelPreventDefault = harness.wheel({ deltaMode: 0, deltaX: 0, deltaY: 96 });
    expect(pixelPreventDefault).toHaveBeenCalledOnce();
    expect(harness.scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 96 });

    harness.scrollBy.mockClear();
    const linePreventDefault = harness.wheel({ deltaMode: 1, deltaX: 0, deltaY: 3 });
    expect(linePreventDefault).toHaveBeenCalledOnce();
    expect(harness.scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 48 });

    harness.scrollBy.mockClear();
    const pagePreventDefault = harness.wheel({ deltaMode: 2, deltaX: 0, deltaY: 1 });
    expect(pagePreventDefault).toHaveBeenCalledOnce();
    expect(harness.scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 160 });

    await harness.unmount();
    expect(harness.removeEventListener).toHaveBeenCalledWith("wheel", registeredListener);
  } catch (error) {
    await harness.unmount();
    throw error;
  }
});

it("leaves horizontal wheel, ctrl+wheel zoom, and non-overflowing category strips untouched", async () => {
  const harness = categoryTabsHarness();
  try {
    await harness.render(null);
    harness.scrollBy.mockClear();

    const horizontalPreventDefault = harness.wheel({ deltaX: 24, deltaY: 96 });
    expect(horizontalPreventDefault).not.toHaveBeenCalled();
    expect(harness.scrollBy).not.toHaveBeenCalled();

    const zoomPreventDefault = harness.wheel({ ctrlKey: true, deltaY: 96 });
    expect(zoomPreventDefault).not.toHaveBeenCalled();
    expect(harness.scrollBy).not.toHaveBeenCalled();

    harness.setScrollWidth(160);
    const noOverflowPreventDefault = harness.wheel({ deltaY: 96 });
    expect(noOverflowPreventDefault).not.toHaveBeenCalled();
    expect(harness.scrollBy).not.toHaveBeenCalled();
  } finally {
    await harness.unmount();
  }
});

it("scrolls category tabs horizontally on mouse drag and suppresses the post-drag click", async () => {
  const harness = categoryTabsHarness();
  try {
    await harness.render(null);
    harness.setScrollLeft(20);

    harness.pointerDown({ clientX: 200, pointerId: 7 });
    harness.pointerMove({ clientX: 196, pointerId: 7 });
    expect(harness.getScrollLeft()).toBe(20);
    expect(harness.dataset.dragging).toBeUndefined();
    expect(harness.setPointerCapture).not.toHaveBeenCalled();

    harness.pointerMove({ clientX: 120, pointerId: 7 });
    expect(harness.getScrollLeft()).toBe(100);
    expect(harness.dataset.dragging).toBe("true");
    expect(harness.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);

    harness.pointerUp({ clientX: 120, pointerId: 7 });
    expect(harness.dataset.dragging).toBeUndefined();
    expect(harness.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);

    const suppressed = harness.clickCapture();
    expect(suppressed.preventDefault).toHaveBeenCalledOnce();
    expect(suppressed.stopPropagation).toHaveBeenCalledOnce();

    const nextClick = harness.clickCapture();
    expect(nextClick.preventDefault).not.toHaveBeenCalled();
    expect(nextClick.stopPropagation).not.toHaveBeenCalled();

    expect(harness.dragStart()).toHaveBeenCalledOnce();
  } finally {
    await harness.unmount();
  }
});

it("keeps short mouse clicks, touch drags, and non-overflowing strips out of mouse drag-scrolling", async () => {
  const harness = categoryTabsHarness();
  try {
    await harness.render(null);

    harness.pointerDown({ clientX: 150, pointerId: 1 });
    harness.pointerMove({ clientX: 148, pointerId: 1 });
    harness.pointerUp({ clientX: 148, pointerId: 1 });
    const shortClick = harness.clickCapture();
    expect(shortClick.preventDefault).not.toHaveBeenCalled();
    expect(shortClick.stopPropagation).not.toHaveBeenCalled();
    expect(harness.getScrollLeft()).toBe(0);

    harness.pointerDown({ clientX: 150, pointerId: 2, pointerType: "touch" });
    harness.pointerMove({ clientX: 60, pointerId: 2, pointerType: "touch" });
    harness.pointerUp({ clientX: 60, pointerId: 2, pointerType: "touch" });
    expect(harness.getScrollLeft()).toBe(0);
    expect(harness.setPointerCapture).not.toHaveBeenCalled();

    harness.setScrollWidth(160);
    harness.pointerDown({ clientX: 150, pointerId: 3 });
    harness.pointerMove({ clientX: 40, pointerId: 3 });
    harness.pointerUp({ clientX: 40, pointerId: 3 });
    expect(harness.getScrollLeft()).toBe(0);
    expect(harness.dragStart()).not.toHaveBeenCalled();
  } finally {
    await harness.unmount();
  }
});
