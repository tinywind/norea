import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  return {
    storageDescriptor,
    windowDescriptor,
    values,
    effect: undefined as (() => void | (() => void)) | undefined,
    dependencies: undefined as readonly unknown[] | undefined,
  };
});

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: typeof harness.effect, dependencies: readonly unknown[]) => {
    harness.effect = effect;
    harness.dependencies = dependencies;
  },
}));

import { useLibraryStore } from "../../store/library";
import { useLibraryEntry } from "./use-library-entry";

const storage = useLibraryStore.persist.getOptions().storage!;
let previousDependencies: readonly unknown[] | undefined;
let cleanup: void | (() => void);

function renderLibrary(active: boolean) {
  useLibraryEntry(active);
  const dependencies = harness.dependencies!;
  if (
    !previousDependencies ||
    dependencies.some((value, index) => !Object.is(value, previousDependencies![index]))
  ) {
    if (typeof cleanup === "function") cleanup();
    cleanup = harness.effect!();
    previousDependencies = dependencies;
  }
}

function unmountLibrary() {
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  previousDependencies = undefined;
}

async function startDelayedHydration(defaultCategoryId: number) {
  useLibraryStore.getState().setDefaultCategoryId(defaultCategoryId);
  const saved = await storage.getItem("norea-library-settings");
  useLibraryStore.setState({ defaultCategoryId: null });
  let finishRead!: (value: typeof saved) => void;
  const read = new Promise<typeof saved>((resolve) => { finishRead = resolve; });
  useLibraryStore.persist.setOptions({ storage: { ...storage, getItem: () => read } });
  const hydration = useLibraryStore.persist.rehydrate();
  return async () => {
    finishRead(saved);
    await hydration;
  };
}

beforeEach(() => {
  harness.values.clear();
  useLibraryStore.setState({
    defaultCategoryId: null,
    selectedCategoryId: null,
    librarySessionInitialized: false,
    sortOrder: "dateAddedDesc",
    unreadOnlyMode: false,
    completedOnlyMode: false,
  });
});

afterEach(() => {
  unmountLibrary();
  useLibraryStore.persist.setOptions({ storage });
});

afterAll(() => {
  if (harness.storageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", harness.storageDescriptor);
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
  if (harness.windowDescriptor) {
    Object.defineProperty(globalThis, "window", harness.windowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
});

describe("library entry lifecycle", () => {
  it("applies the saved default only on the first active library visit", () => {
    useLibraryStore.getState().setDefaultCategoryId(7);
    renderLibrary(false);
    expect(useLibraryStore.getState().librarySessionInitialized).toBe(false);

    renderLibrary(true);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(7);
    expect(useLibraryStore.getState().librarySessionInitialized).toBe(true);
  });

  it.each([9, null])("keeps the chosen category %s when returning from a novel or reader", (categoryId) => {
    useLibraryStore.getState().setDefaultCategoryId(7);
    renderLibrary(true);
    useLibraryStore.getState().setSelectedCategoryId(categoryId);

    renderLibrary(false);
    renderLibrary(true);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(categoryId);

    renderLibrary(false);
    renderLibrary(true);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(categoryId);
  });

  it("retains the chosen category across sorting, filters, and repeated renders", () => {
    useLibraryStore.getState().setDefaultCategoryId(7);
    renderLibrary(true);
    useLibraryStore.getState().setSelectedCategoryId(9);

    useLibraryStore.getState().setSortOrder("nameAsc");
    renderLibrary(true);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(9);

    useLibraryStore.getState().setSortOrder("nameDesc");
    useLibraryStore.getState().setUnreadOnlyMode(true);
    renderLibrary(true);
    renderLibrary(true);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(9);
  });

  it("keeps the current selection after changing the default, returning, and remounting", () => {
    useLibraryStore.getState().setDefaultCategoryId(7);
    renderLibrary(true);
    useLibraryStore.getState().setSelectedCategoryId(9);

    renderLibrary(false);
    useLibraryStore.getState().setDefaultCategoryId(-1);
    renderLibrary(true);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(9);

    unmountLibrary();
    renderLibrary(true);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(9);
  });

  it("waits for persisted settings before choosing the initial category", async () => {
    const finishHydration = await startDelayedHydration(7);
    renderLibrary(true);
    expect(useLibraryStore.getState().librarySessionInitialized).toBe(false);
    expect(useLibraryStore.getState().selectedCategoryId).toBeNull();

    await finishHydration();
    expect(useLibraryStore.getState().selectedCategoryId).toBe(7);
    expect(useLibraryStore.getState().librarySessionInitialized).toBe(true);
  });

  it("waits until the library becomes active if hydration finishes while it is hidden", async () => {
    const finishHydration = await startDelayedHydration(7);
    renderLibrary(true);
    renderLibrary(false);

    await finishHydration();
    expect(useLibraryStore.getState().librarySessionInitialized).toBe(false);
    expect(useLibraryStore.getState().selectedCategoryId).toBeNull();

    renderLibrary(true);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(7);
  });

  it.each([9, null])("preserves an explicit category choice %s made before hydration finishes", async (categoryId) => {
    const finishHydration = await startDelayedHydration(7);
    renderLibrary(true);
    useLibraryStore.getState().setSelectedCategoryId(categoryId);

    await finishHydration();
    expect(useLibraryStore.getState().defaultCategoryId).toBe(7);
    expect(useLibraryStore.getState().selectedCategoryId).toBe(categoryId);
  });
});
