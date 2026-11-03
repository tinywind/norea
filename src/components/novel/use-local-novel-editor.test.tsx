import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePageBackNavigation } from "../../lib/android-back-navigation";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, error: null, reset: vi.fn(), mutate: vi.fn() }),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/chapter", () => ({ listChaptersByNovel: vi.fn() }));
vi.mock("../../db/queries/novel", () => ({ reorderLocalNovelChapters: vi.fn(), updateLocalNovelMetadata: vi.fn() }));
vi.mock("../../lib/local-chapter-storage", () => ({ syncLocalChapterStorageAfterOrderChange: vi.fn() }));
vi.mock("../../lib/local-import", () => ({ clearLocalImportFileCache: vi.fn() }));
vi.mock("../../lib/local-import-library", () => ({ importLocalFileToLibrary: vi.fn() }));
vi.mock("../LocalCoverPicker", () => ({ LocalCoverPicker: () => null }));

import { useLocalNovelEditor } from "./use-local-novel-editor";

const novel = {
  id: 3, name: "Local work", path: "/local", pluginId: "local", sourceNovelId: null, isLocal: true,
  cover: null, summary: null, author: null, artist: null, status: null, genres: null,
};
let harness: BackNavigationHarness | undefined;
let current: ReturnType<typeof useLocalNovelEditor>;
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
  current = useLocalNovelEditor(novel.id, novel, [], "asc");
  return null;
}

const metadataModal = () => collectElements(current.editor)
  .find((element) => element.props.title === "novel.local.editMetadata")!;

it("closes the local metadata editor on back without leaving the novel page", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<Page><EditorProbe /></Page>);
  expect(metadataModal().props.opened).toBe(false);

  await harness.run(() => current.openLocalMetadataEditor());
  expect(metadataModal().props.opened).toBe(true);

  expect(harness.pressBack()).toBe(true);
  expect(metadataModal().props.opened).toBe(false);
  expect(pageBack).not.toHaveBeenCalled();
});
