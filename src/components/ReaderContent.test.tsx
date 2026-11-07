import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectElements } from "../lib/android-back-navigation.test-support";
import type { ReaderAppearanceSettings, ReaderGeneralSettings } from "../store/reader";
import { ReaderContent } from "./ReaderContent";
import { prepareReaderDocument } from "./reader-document";
import { ReaderSeekbars } from "./ReaderSeekbars";
import { ReaderStatusOverlay } from "./reader/ReaderStatusOverlay";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  node: { customCalls: 0 },
  pageActive: true,
  width: 800,
  height: 600,
  revision: 0,
  css: ".reader-content,\n  .reader-viewport-paged .reader-content { color: red; }",
  general: {} as ReaderGeneralSettings,
  appearance: {} as ReaderAppearanceSettings,
  wake: vi.fn(), auto: vi.fn(), progress: vi.fn(), gestures: vi.fn(), layout: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  memo: <T,>(component: T) => component,
  forwardRef: <T,>(component: T) => component,
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect),
  useLayoutEffect: vi.fn(),
  useImperativeHandle: vi.fn(),
  useId: () => "reader-test",
  useRef: <T,>(value: T) => ({ current: value === null ? mocks.node : value }),
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/page-activity", () => ({ usePageActivity: () => mocks.pageActive }));
vi.mock("../store/reader", async original => {
  const actual = await original<typeof import("../store/reader")>();
  const state = actual.useReaderStore.getState();
  mocks.general = state.general;
  mocks.appearance = state.appearance;
  return { ...actual, useReaderStore: (selector: (value: typeof state) => unknown) => selector(state) };
});
vi.mock("./reader/use-reader-wake-lock", () => ({ useReaderWakeLock: (enabled: boolean) => mocks.wake(enabled) }));
vi.mock("./reader/use-reader-auto-scroll", () => ({ useReaderAutoScroll: (...args: unknown[]) => mocks.auto(...args) }));
vi.mock("./reader/use-reader-layout-revision", () => ({ useReaderLayoutRevision: () => mocks.revision }));
vi.mock("./reader/use-reader-content-style", () => ({ useReaderContentStyle: () => ({ contentBoxStyle: {}, readerContentRuntimeCss: mocks.css }) }));
vi.mock("./reader/use-reader-gestures", () => ({ useReaderGestures: (options: unknown) => { mocks.gestures(options); return {}; } }));
vi.mock("./reader/use-reader-content-media", () => ({ useReaderContentMedia: () => ({
  patchMediaElements: vi.fn(), restoreMediaPatches: vi.fn(), resolvedLocalMediaMap: new Map(), hasLocalMediaContext: false,
}) }));
vi.mock("./reader/use-reader-scroll-layout", () => ({ useReaderScrollLayout: (options: unknown) => {
  mocks.layout(options);
  return {
    viewportSize: { width: mocks.width, height: mocks.height }, activeVirtualRangeStart: 0, activeVirtualRangeEnd: -1,
    shouldVirtualizeScrollContent: false, segmentOffsets: [], virtualContentHeight: 600,
    getActiveScrollNode: () => null, pageScrollAnimatingRef: { current: false }, nativeWheelActionLockedUntilRef: { current: 0 },
    cancelPagedScrollAnimation: vi.fn(), enforceScrollStepFloor: vi.fn(), syncScrollVirtualRange: vi.fn(), scrollByPage: vi.fn(),
  };
} }));
vi.mock("./reader/use-reader-progress", () => ({ useReaderProgress: (options: unknown) => {
  mocks.progress(options);
  return { progress: 0, pageInfo: { current: 1, total: 4 }, updateProgressFromScroll: vi.fn(), completeIfAtEnd: vi.fn(), seekToProgress: vi.fn(), commitSeekProgress: vi.fn() };
} }));

const document = prepareReaderDocument("<p>Next chapter</p>", false);
function render(preparing: boolean, overrides: Partial<ComponentProps<typeof ReaderContent>> = {}) {
  const props: ComponentProps<typeof ReaderContent> = {
    html: document.html, preparedDocument: document, contentKey: "2:stored", preparing,
    appearanceSettings: { ...mocks.appearance, customJs: "container.customCalls += 1;" },
    generalSettings: { ...mocks.general, keepScreenOn: true, autoScroll: true, pageReader: false },
    onProgressChange: vi.fn(), onScrollAnchorChange: vi.fn(), onPageIndexChange: vi.fn(), onBoundaryPage: vi.fn(),
    viewportHeight: "100%", ...overrides,
  };
  const tree = (ReaderContent as unknown as (props: ComponentProps<typeof ReaderContent>, ref: null) => ReactNode)(props, null);
  mocks.effects.forEach(effect => effect());
  mocks.effects = [];
  return collectElements(tree);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects = [];
  mocks.node.customCalls = 0;
  mocks.pageActive = true;
  mocks.width = 800;
  mocks.height = 600;
  mocks.revision = 0;
});

it("lays out a hidden chapter at full size without persistence, input, custom script, or global reader effects", () => {
  const elements = render(true);
  const stage = elements.find(element => element.props.className === "norea-reader-content-stage")!;
  expect(stage.props).toMatchObject({ "aria-hidden": true, inert: true, "data-reader-preparing": true });
  expect(stage.props.style).toMatchObject({ height: "100%", position: "absolute", inset: 0, visibility: "hidden" });
  expect(stage.props.style).not.toHaveProperty("display");
  expect(mocks.wake).toHaveBeenCalledWith(false);
  expect(mocks.auto.mock.calls[0]![1]).toBe(false);
  expect(mocks.progress.mock.calls[0]![0]).toMatchObject({
    preparing: true, onProgressChange: undefined, onScrollAnchorChange: undefined, onPageIndexChange: undefined,
  });
  expect(mocks.layout.mock.calls[0]![0].onBoundaryPage).toBeUndefined();
  expect(mocks.gestures.mock.calls[0]![0].interactionBlocked).toBe(true);
  expect(mocks.node.customCalls).toBe(0);
  expect(elements.some(element => element.type === ReaderSeekbars || element.type === ReaderStatusOverlay)).toBe(false);
});

it("scopes generated layout CSS to its own stage while both readers are mounted", () => {
  const elements = render(true);
  expect(elements[0]!.props["data-reader-scope"]).toBe("reader-test");
  const style = elements.find(element => element.type === "style")!;
  expect(style.props.children).toBe('[data-reader-scope="reader-test"] .reader-content,\n  [data-reader-scope="reader-test"] .reader-viewport-paged .reader-content { color: red; }');
});

it("activates normal reader behavior only after promotion", () => {
  const elements = render(false);
  expect(elements[0]!.props.inert).toBe(false);
  expect(mocks.wake).toHaveBeenCalledWith(true);
  expect(mocks.auto.mock.calls[0]![1]).toBe(true);
  expect(mocks.progress.mock.calls[0]![0].onProgressChange).toBeTypeOf("function");
  expect(mocks.node.customCalls).toBe(1);
  expect(elements.some(element => element.type === ReaderSeekbars)).toBe(true);
});

it("also suspends effects when the reader page itself is inactive", () => {
  mocks.pageActive = false;
  render(false);
  expect(mocks.wake).toHaveBeenCalledWith(false);
  expect(mocks.auto.mock.calls[0]![1]).toBe(false);
  expect(mocks.progress.mock.calls[0]![0].onProgressChange).toBeUndefined();
  expect(mocks.node.customCalls).toBe(0);
});

describe("prepared layout invalidation", () => {
  it("includes viewport, font, mode, spacing, CSS, and completed media/font revisions", () => {
    const keys = new Set<string>();
    const capture = (overrides: Partial<ComponentProps<typeof ReaderContent>> = {}) => {
      render(true, overrides);
      keys.add(mocks.progress.mock.lastCall![0].layoutRestoreKey);
    };
    capture();
    mocks.width = 600; capture();
    capture({ appearanceSettings: { ...mocks.appearance, fontFamily: "Other Font" } });
    capture({ appearanceSettings: { ...mocks.appearance, customCss: ".reader-content { letter-spacing: 1px }" } });
    capture({ generalSettings: { ...mocks.general, bionicReading: true } });
    capture({ generalSettings: { ...mocks.general, removeExtraParagraphSpacing: !mocks.general.removeExtraParagraphSpacing } });
    capture({ generalSettings: { ...mocks.general, pageReader: true } });
    mocks.height = 900; capture({ generalSettings: { ...mocks.general, pageReader: true } });
    mocks.revision += 1; capture();
    expect(keys.size).toBe(9);
  });
});
