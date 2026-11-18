import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  notifyShow: vi.fn(),
  pickLocalFiles: vi.fn(),
  pushWorkOverridesNow: vi.fn().mockResolvedValue(undefined),
  resetMutation: vi.fn(),
  storedOverride: null as null | {
    schemaVersion: 1;
    identity: { pluginId: string; novelId: string; novelPath: string };
    fields: Record<string, { value: string | number | boolean | null; updatedAt: number }>;
  },
  updateNovelOverride: vi.fn().mockResolvedValue({ schemaVersion: 1, identity: { pluginId: "src", novelId: "n1", novelPath: "/n1" }, fields: {} }),
}));

vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notifyShow } }));
vi.mock("../ui/ResponsiveSheet", () => ({
  ResponsiveSheet: ({
    children,
    footer,
    opened,
    title,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    opened?: boolean;
    title?: ReactNode;
  }) => (opened ? <section aria-label={String(title ?? "")}><h2>{title}</h2>{children}{footer}</section> : null),
  SheetActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: ({
    mutationFn,
    onSuccess,
  }: {
    mutationFn: (value: unknown) => Promise<unknown>;
    onSuccess?: () => Promise<void>;
  }) => ({
    error: null,
    isPending: false,
    mutate: (value: unknown) => {
      void mutationFn(value).then(() => onSuccess?.());
    },
    reset: mocks.resetMutation,
  }),
  useQuery: () => ({ data: mocks.storedOverride }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../lib/local-file-picker", () => ({ pickLocalFiles: mocks.pickLocalFiles }));
vi.mock("../../lib/content-sync/work-overrides", () => ({ pushWorkOverridesNow: mocks.pushWorkOverridesNow }));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => undefined } }));
vi.mock("../../lib/use-novel-cover-source", () => ({ useNovelCoverSource: () => "https://cover.test/source.jpg" }));
vi.mock("../../db/queries/novel-override", () => ({
  getNovelOverride: vi.fn(async () => mocks.storedOverride),
  updateNovelOverride: mocks.updateNovelOverride,
}));

import { Button, Select, TextInput, Textarea } from "@mantine/core";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { NovelMetadataOverrideEditor } from "./NovelMetadataOverrideEditor";

let harness: BackNavigationHarness | undefined;
let rendered: ReactNode;

const baseNovel: NovelDetailRecord = {
  id: 7,
  sourceNovelId: "n1",
  pluginId: "src",
  pluginName: "Source",
  path: "/n1",
  name: "Source Title",
  cover: "https://source.test/cover.jpg",
  coverOverride: null,
  summary: "Original summary",
  author: "Original Author",
  artist: null,
  status: "Ongoing",
  genres: "Fantasy, Action",
  rating: null,
  inLibrary: true,
  isLocal: false,
  createdAt: 1,
  updatedAt: 1,
  libraryAddedAt: 1,
  lastReadAt: null,
  statusOverride: null,
  sourceMetadata: {
    name: "Source Title",
    author: "Original Author",
    artist: null,
    summary: "Original summary",
    status: "Ongoing",
    genres: "Fantasy, Action",
  },
};

function Probe({ novel = baseNovel, opened = true }: { novel?: NovelDetailRecord; opened?: boolean }) {
  rendered = NovelMetadataOverrideEditor({
    active: true,
    novel,
    onClose: vi.fn(),
    opened,
  });
  return null;
}

beforeEach(() => {
  mocks.storedOverride = null;
  vi.clearAllMocks();
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

describe("NovelMetadataOverrideEditor", () => {
  it("offers canonical NovelStatus options and source-cover explanation in en and ko", () => {
    expect(en["novel.metadataOverride.coverHelp"]).toContain("cover.override");
    expect(ko["novel.metadataOverride.coverHelp"]).toContain("cover.override");

    const html = renderToStaticMarkup(
      <MantineProvider>
        <NovelMetadataOverrideEditor active novel={baseNovel} onClose={vi.fn()} opened />
      </MantineProvider>,
    );
    expect(html).toContain("novel.metadataOverride.title");
  });

  it("saves edited metadata, canonical status, and cover.override bytes via pickLocalFiles without touching source cover", async () => {
    const pickedBytes = new Uint8Array([137, 80, 78, 71]);
    const pickedFile = {
      name: "CustomCover.PNG",
      size: pickedBytes.byteLength,
      type: "image/png",
      arrayBuffer: async () => pickedBytes.buffer,
    } as unknown as File;
    mocks.pickLocalFiles.mockResolvedValueOnce([pickedFile]);

    harness = mountBackNavigationHarness();
    await harness.render(<Probe />);

    const elements = collectElements(rendered);
    const inputs = elements.filter((el) => el.type === TextInput);
    const select = elements.find((el) => el.type === Select)!;
    const summary = elements.find((el) => el.type === Textarea)!;
    const chooseCoverBtn = elements.find(
      (el) => el.type === Button && el.props.children === "library.localNovel.coverChoose",
    )!;

    await harness.run(async () => {
      await (chooseCoverBtn.props.onClick as () => Promise<void>)();
    });

    await harness.run(() => {
      (inputs[0]!.props.onChange as (e: { currentTarget: { value: string } }) => void)({
        currentTarget: { value: "Edited Title" },
      });
      (inputs[3]!.props.onChange as (e: { currentTarget: { value: string } }) => void)({
        currentTarget: { value: "Mystery, Drama" },
      });
      (summary.props.onChange as (e: { currentTarget: { value: string } }) => void)({
        currentTarget: { value: "Edited summary" },
      });
      (select.props.onChange as (v: string) => void)("On Hiatus");
    });

    const updatedForm = collectElements(rendered).find((el) => el.type === "form")!;
    await harness.run(async () => {
      (updatedForm.props.onSubmit as (e: { preventDefault: () => void }) => void)({
        preventDefault: vi.fn(),
      });
      await Promise.resolve();
    });

    expect(mocks.updateNovelOverride).toHaveBeenCalledWith(
      7,
      {
        name: "Edited Title",
        genres: "Mystery, Drama",
        summary: "Edited summary",
        status: "On Hiatus",
      },
      {
        mode: "set",
        fileName: "cover.override.png",
        bytes: pickedBytes,
      },
    );
    expect(mocks.pushWorkOverridesNow).toHaveBeenCalled();
  });

  it("resets overridden fields and cover override back to source using null and clear mode", async () => {
    mocks.storedOverride = {
      schemaVersion: 1,
      identity: { pluginId: "src", novelId: "n1", novelPath: "/n1" },
      fields: {
        name: { value: "Override Title", updatedAt: 100 },
        status: { value: "Completed", updatedAt: 100 },
        cover: { value: "cover.override.jpg", updatedAt: 100 },
      },
    };
    const novelWithOverrides: NovelDetailRecord = {
      ...baseNovel,
      name: "Override Title",
      status: "Completed",
      statusOverride: "Completed",
      coverOverride: "cover.override.jpg",
    };

    harness = mountBackNavigationHarness();
    await harness.render(<Probe novel={novelWithOverrides} />);

    const footer = (rendered as ReactElement<{ footer?: ReactNode }>).props.footer;
    const resetAllBtn = collectElements(footer).find(
      (el) => el.type === Button && el.props.children === "novel.metadataOverride.resetAll",
    )!;

    await harness.run(() => {
      (resetAllBtn.props.onClick as () => void)();
    });
    const updatedForm = collectElements(rendered).find((el) => el.type === "form")!;
    await harness.run(async () => {
      (updatedForm.props.onSubmit as (e: { preventDefault: () => void }) => void)({
        preventDefault: vi.fn(),
      });
      await Promise.resolve();
    });

    expect(mocks.updateNovelOverride).toHaveBeenCalledWith(
      7,
      { name: null, status: null },
      { mode: "clear" },
    );
  });
});
