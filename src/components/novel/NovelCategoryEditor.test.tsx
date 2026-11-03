import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePageBackNavigation } from "../../lib/android-back-navigation";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: queryKey[1] === "list" ? [{ id: 4, name: "Favorites", isSystem: false }] : [4],
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ isPending: false, error: null, reset: vi.fn(), mutate: vi.fn() }),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/category", () => ({
  getNovelCategoryIds: vi.fn(),
  listCategories: vi.fn(),
  NovelCategoryError: class extends Error {},
  setNovelCategories: vi.fn(),
}));

import { NovelCategoryEditor } from "./NovelCategoryEditor";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;
const pageBack = vi.fn(() => true);

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

function Page({ children }: { children: ReactNode }) {
  usePageBackNavigation(pageBack);
  return children;
}

function EditorProbe() {
  tree = NovelCategoryEditor({ active: true, novelId: 3, novelName: "Saved novel" });
  return null;
}

const drawer = () => collectElements(tree).find((element) => element.props.title === "categories.editWork")!;
const editButton = () => collectElements(tree).find((element) =>
  element.props.children === "categories.editWork" && typeof element.props.onClick === "function")!;

it("closes the category drawer on back without leaving the novel page", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<Page><EditorProbe /></Page>);
  expect(drawer().props.opened).toBe(false);

  await harness.run(() => (editButton().props.onClick as () => void)());
  expect(drawer().props.opened).toBe(true);

  expect(harness.pressBack()).toBe(true);
  expect(drawer().props.opened).toBe(false);
  expect(pageBack).not.toHaveBeenCalled();

  harness.pressBack();
  expect(pageBack).toHaveBeenCalledTimes(1);
});
