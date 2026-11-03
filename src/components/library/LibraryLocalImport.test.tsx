import { createRef, type ReactNode, type Ref } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  mutationIndex: 0,
  localHome: { isPending: false, error: null as unknown, reset: () => { mocks.localHome.error = null; }, mutate: () => undefined },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => mocks.mutationIndex++ % 2 === 1
    ? mocks.localHome
    : { isPending: false, error: null, reset: vi.fn(), mutate: vi.fn() },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("../../db/queries/novel", () => ({ upsertLocalNovel: vi.fn() }));
vi.mock("../../lib/local-import", () => ({ clearLocalImportFileCache: vi.fn() }));
vi.mock("../../lib/local-import-library", () => ({ importLocalFileToLibrary: vi.fn() }));
vi.mock("../../store/library", () => ({
  useLibraryStore: (selector: (state: unknown) => unknown) => selector({ pendingLocalImportFiles: [], takePendingLocalImportFiles: () => [] }),
}));
vi.mock("./local-import-review", () => ({
  analyzeLocalImportReviewItem: async (file: File, index: number) => ({ id: String(index), file, status: "ready" }),
  getLocalImportErrorMessage: (error: unknown) => String(error),
  getLocalImportSummary: () => "summary",
  markSelectedLocalImportDuplicates: (items: unknown[]) => items,
}));
vi.mock("./LocalImportReviewRow", () => ({ LocalImportReviewRow: () => null }));

import { LibraryLocalImport, type LibraryLocalImportHandle } from "./LibraryLocalImport";

type ImportRender = (props: { active: boolean }, ref: Ref<LibraryLocalImportHandle>) => ReactNode;

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  mocks.localHome.error = null;
});

function ImportProbe() {
  mocks.mutationIndex = 0;
  tree = (LibraryLocalImport as unknown as { render: ImportRender }).render({ active: true }, createRef());
  return null;
}

const modal = (title: string) => collectElements(tree).find((element) => element.props.title === title)!;

it("closes the local import review on back without leaving the library", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<ImportProbe />);
  const input = collectElements(tree).find((element) => element.props.type === "file")!;
  await harness.run(() => (input.props.onChange as (event: unknown) => void)({
    currentTarget: { files: [new File(["text"], "work.txt")], value: "work.txt" },
  }));
  expect(modal("library.localImport.title").props.opened).toBe(true);

  expect(harness.pressBack()).toBe(true);
  expect(modal("library.localImport.title").props.opened).toBe(false);
  expect(harness.pressBack()).toBe(false);
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
