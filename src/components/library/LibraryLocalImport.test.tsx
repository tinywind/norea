import { createRef, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  analyses: [] as Array<{ file: File; resolve: () => void }>,
  imports: [] as Array<{ file: File; resolve: (novelId: number) => void }>,
  navigate: vi.fn(),
  localHome: { isPending: false, error: null as unknown, reset: () => { mocks.localHome.error = null; }, mutate: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => mocks.localHome,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("../../db/queries/novel", () => ({ upsertLocalNovel: vi.fn() }));
vi.mock("../../lib/local-import", () => ({ clearLocalImportFileCache: vi.fn() }));
vi.mock("../../lib/local-import-library", () => ({
  importLocalFileToLibrary: (file: File) => {
    const pending = deferred<number>();
    mocks.imports.push({ file, resolve: pending.resolve });
    return pending.promise.then((novelId) => ({ chapterCount: 1, novelId }));
  },
}));
vi.mock("../../store/library", () => ({
  useLibraryStore: (selector: (state: unknown) => unknown) => selector({ pendingLocalImportFiles: [], takePendingLocalImportFiles: () => [] }),
}));
vi.mock("./local-import-review", () => ({
  analyzeLocalImportReviewItem: (file: File, index: number) => {
    const pending = deferred<void>();
    mocks.analyses.push({ file, resolve: pending.resolve });
    return pending.promise.then(() => ({ id: `${file.name}:${index}`, file, status: "ready" }));
  },
  getLocalImportErrorMessage: (error: unknown) => String(error),
  getLocalImportSummary: () => "summary",
  markSelectedLocalImportDuplicates: (items: unknown[]) => items,
}));
vi.mock("./LocalImportReviewRow", () => ({ LocalImportReviewRow: () => null }));

import { LibraryLocalImport, type LibraryLocalImportHandle } from "./LibraryLocalImport";

type ImportRender = (props: { active: boolean }, ref: Ref<LibraryLocalImportHandle>) => ReactNode;

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

beforeEach(() => {
  mocks.analyses.length = 0;
  mocks.imports.length = 0;
  mocks.navigate.mockClear();
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  mocks.localHome.error = null;
});

function ImportProbe() {
  tree = (LibraryLocalImport as unknown as { render: ImportRender }).render({ active: true }, createRef());
  return null;
}

const elements = () => collectElements(tree);
const modal = (title: string) => elements().find((element) => element.props.title === title)!;
const reviewModal = () => modal("library.localImport.title");
const reviewedFiles = () =>
  elements().filter((element) => element.props.item !== undefined)
    .map((element) => (element.props.item as { file: File }).file.name);
const button = (label: string) => elements().find((element) => element.props.children === label);

async function chooseFiles(...names: string[]) {
  const input = elements().find((element) => element.props.type === "file")!;
  await harness!.run(() => (input.props.onChange as (event: unknown) => void)({
    currentTarget: { files: names.map((name) => new File(["text"], name)), value: names[0] },
  }));
}

async function finishAnalyses() {
  await harness!.run(async () => {
    for (const analysis of mocks.analyses.splice(0)) analysis.resolve();
  });
}

async function finishImports(novelId = 9) {
  await harness!.run(async () => {
    while (mocks.imports.length > 0) {
      mocks.imports.shift()!.resolve(novelId);
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    }
  });
}

it("closes the local import review on back without leaving the library", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<ImportProbe />);
  await chooseFiles("work.txt");
  await finishAnalyses();
  expect(reviewModal().props.opened).toBe(true);

  expect(harness.pressBack()).toBe(true);
  expect(reviewModal().props.opened).toBe(false);
  expect(harness.pressBack()).toBe(false);
});

it("blocks closing while files are analyzed and imported", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<ImportProbe />);
  await chooseFiles("a.txt", "b.txt");
  expect(reviewModal().props).toMatchObject({ opened: true, closeOnEscape: false, closeOnClickOutside: false, withCloseButton: false });
  await harness.run(() => (reviewModal().props.onClose as () => void)());
  harness.pressBack();
  expect(reviewModal().props.opened).toBe(true);

  await finishAnalyses();
  await harness.run(() => (button("library.localImport.importReady")!.props.onClick as () => void)());
  expect(reviewModal().props.closeOnEscape).toBe(false);
  harness.pressBack();
  expect(reviewModal().props.opened).toBe(true);
});

it("queues a request that arrives during an import until the result is acknowledged", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<ImportProbe />);
  await chooseFiles("a.txt", "b.txt");
  await finishAnalyses();
  await harness.run(() => (button("library.localImport.importReady")!.props.onClick as () => void)());

  await chooseFiles("c.txt");
  expect(mocks.analyses).toHaveLength(0);
  expect(reviewedFiles()).toEqual(["a.txt", "b.txt"]);
  expect(button("library.localImport.waiting")).toBeDefined();

  await finishImports();
  expect(reviewedFiles()).toEqual(["a.txt", "b.txt"]);
  expect(button("library.localImport.result")).toBeDefined();
  expect(button("library.localImport.importReady")).toBeUndefined();
  expect(mocks.navigate).not.toHaveBeenCalled();

  await harness.run(() => (button("common.done")!.props.onClick as () => void)());
  expect(reviewModal().props.opened).toBe(true);
  expect(mocks.analyses.map((analysis) => analysis.file.name)).toEqual(["c.txt"]);
  await finishAnalyses();
  expect(reviewedFiles()).toEqual(["c.txt"]);
  expect(button("library.localImport.waiting")).toBeUndefined();
});

it("opens the local work after a single-file import", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<ImportProbe />);
  await chooseFiles("one.txt");
  await finishAnalyses();
  await harness.run(() => (button("library.localImport.importReady")!.props.onClick as () => void)());
  await finishImports(42);
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/novel", search: { id: 42 } });
  expect(reviewModal().props.opened).toBe(false);
});

it("dismisses the local library error on back without leaving the library", async () => {
  mocks.localHome.error = new Error("Local library unavailable");
  harness = mountBackNavigationHarness();
  await harness.render(<ImportProbe />);
  expect(modal("library.localNovel.title").props.opened).toBe(true);

  expect(harness.pressBack()).toBe(true);
  await harness.render(<ImportProbe />);
  expect(modal("library.localNovel.title").props.opened).toBe(false);
  expect(harness.pressBack()).toBe(false);
});
