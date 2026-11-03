import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";
import type { NovelDetailRecord } from "../../db/queries/novel";

const mocks = vi.hoisted(() => ({
  block: undefined as unknown,
  mutateAsync: vi.fn<() => Promise<unknown>>(),
  openPluginSite: vi.fn(),
  strings: {} as Record<string, string>,
}));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) =>
      Object.entries(values).reduce(
        (message, [name, value]) => message.replace(`{${name}}`, String(value)),
        mocks.strings[key] ?? key,
      ),
  }),
}));
vi.mock("../novel/use-novel-metadata", () => ({
  useNovelMetadata: () => ({ refreshMetadata: { mutateAsync: mocks.mutateAsync } }),
}));
vi.mock("../SourceAccessVerifyButton", () => ({
  SourceAccessVerifyButton: () => null,
  useSourceAccessBlocks: () => () => mocks.block,
}));
vi.mock("../browse/BrowseSearchTab", () => ({
  isCloudflareError: (message: string) => /cloudflare/i.test(message),
}));
vi.mock("../../lib/plugins/manager", () => ({
  pluginManager: { getPlugin: () => ({ id: "source", name: "Source" }) },
}));
vi.mock("../../lib/plugins/open-plugin-site", () => ({ openPluginSite: mocks.openPluginSite }));

import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import { SourceAccessVerifyButton } from "../SourceAccessVerifyButton";
import {
  ReaderEndOfNovel,
  useNovelEndCheck,
  type NovelEndCheck,
} from "./ReaderEndOfNovel";

const novel = { id: 4, isLocal: false, name: "Novel", pluginId: "source" } as NovelDetailRecord;

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

const handlers = () => ({
  onBackToNovel: vi.fn(),
  onCheck: vi.fn(),
  onContinue: vi.fn(),
});

async function renderCard(check: NovelEndCheck, props = handlers(), cardNovel = novel) {
  function Probe() {
    tree = ReaderEndOfNovel({ check, novel: cardNovel, ...props });
    return null;
  }
  harness ??= mountBackNavigationHarness();
  await harness.render(<Probe />);
  return collectElements(tree);
}

async function renderVerify(element: ReactElement<Record<string, unknown>>) {
  let verifyTree: ReactNode;
  function Probe() {
    verifyTree = (element.type as (props: unknown) => ReactNode)(element.props);
    return null;
  }
  await harness!.render(<Probe />);
  return verifyTree as ReactElement<Record<string, unknown>> | null;
}

const button = (elements: ReactElement<Record<string, unknown>>[], label: string) =>
  elements.find((element) => element.props.children === label && element.props.onClick);

beforeEach(() => {
  mocks.strings = en;
  mocks.block = undefined;
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

it.each([en, ko])("offers Check for new chapters and Back to novel when caught up", async (strings) => {
  mocks.strings = strings;
  const props = handlers();
  const elements = await renderCard({ status: "idle" }, props);
  expect(elements.some((element) => element.props.children === strings["reader.end.title"])).toBe(true);
  (button(elements, strings["reader.end.check"])!.props.onClick as () => void)();
  expect(props.onCheck).toHaveBeenCalledOnce();
  (button(elements, strings["reader.backToNovel"])!.props.onClick as () => void)();
  expect(props.onBackToNovel).toHaveBeenCalledOnce();
});

it("shows the checking state on the check button", async () => {
  const elements = await renderCard({ status: "checking" });
  expect(button(elements, en["reader.end.check"])!.props.loading).toBe(true);
});

it("turns found chapters into a Continue action with the count", async () => {
  const props = handlers();
  const elements = await renderCard({ count: 3, status: "found" }, props);
  const label = en["reader.end.continue"].replace("{count}", "3");
  (button(elements, label)!.props.onClick as () => void)();
  expect(props.onContinue).toHaveBeenCalledOnce();
  expect(button(await renderCard({ count: 1, status: "found" }), en["reader.end.continueOne"])).toBeDefined();
});

it("offers Retry and Verify inline when the check fails", async () => {
  const props = handlers();
  const elements = await renderCard({ error: new Error("Cloudflare challenge"), status: "failed" }, props);
  expect(elements.some((element) => element.props.children === en["reader.end.failed"])).toBe(true);
  (button(elements, en["common.retry"])!.props.onClick as () => void)();
  expect(props.onCheck).toHaveBeenCalledOnce();

  const verify = elements.find((element) => element.props.error)!;
  const siteButton = await renderVerify(verify);
  (siteButton!.props.onClick as () => void)();
  expect(mocks.openPluginSite).toHaveBeenCalledOnce();

  mocks.block = { sourceId: "source" };
  expect((await renderVerify(verify))!.type).toBe(SourceAccessVerifyButton);
  mocks.block = undefined;
  const plain = (await renderCard({ error: new Error("timeout"), status: "failed" }))
    .find((element) => element.props.error)!;
  expect(await renderVerify(plain)).toBeNull();
});

it("only offers Back to novel for a local work", async () => {
  const elements = await renderCard({ status: "idle" }, handlers(), { ...novel, isLocal: true });
  expect(button(elements, en["reader.end.check"])).toBeUndefined();
  expect(button(elements, en["reader.backToNovel"])).toBeDefined();
});

it("refreshes the novel in place, counts new chapters and resets for another chapter", async () => {
  let state: ReturnType<typeof useNovelEndCheck> | undefined;
  const countNewChapters = vi.fn<() => Promise<number>>();
  function Probe({ chapterId }: { chapterId: number }) {
    state = useNovelEndCheck({ chapterId, countNewChapters, novel });
    return null;
  }
  harness = mountBackNavigationHarness();
  await harness.render(<Probe chapterId={9} />);

  mocks.mutateAsync.mockResolvedValueOnce(null);
  countNewChapters.mockResolvedValueOnce(2);
  await harness.run(() => void state!.run());
  expect(mocks.mutateAsync).toHaveBeenCalledOnce();
  expect(state!.check).toEqual({ count: 2, status: "found" });

  mocks.mutateAsync.mockResolvedValueOnce(null);
  countNewChapters.mockResolvedValueOnce(0);
  await harness.run(() => void state!.run());
  expect(state!.check).toEqual({ status: "none" });

  const error = new Error("offline");
  mocks.mutateAsync.mockRejectedValueOnce(error);
  await harness.run(() => void state!.run());
  expect(state!.check).toEqual({ error, status: "failed" });

  await harness.render(<Probe chapterId={10} />);
  expect(state!.check).toEqual({ status: "idle" });
});
