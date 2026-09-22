import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { getDocument } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderContentHandle } from "./ReaderContent";
import { PdfReaderContent } from "./PdfReaderContent";
import { READER_GENERAL_DEFAULTS } from "../store/reader";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  dirty: false,
  values: [] as unknown[],
  pendingEffects: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  const sameDeps = (left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) =>
    left !== undefined && right !== undefined &&
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const useMemo = (factory: () => unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.values[index] as { deps: readonly unknown[]; value: unknown } | undefined;
    if (previous && sameDeps(previous.deps, deps)) return previous.value;
    const value = factory();
    hooks.values[index] = { deps, value };
    return value;
  };
  return {
    ...react,
    useCallback: (callback: unknown, deps: readonly unknown[]) => useMemo(() => callback, deps),
    useMemo,
    useRef: (value: unknown) => {
      const index = hooks.cursor++;
      hooks.values[index] ??= { current: value };
      return hooks.values[index];
    },
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === "function" ? initial() : initial;
      }
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.dirty = true;
        hooks.values[index] = next;
      }];
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.values[index] as { deps?: readonly unknown[]; cleanup?: () => void } | undefined;
      if (previous && sameDeps(previous.deps, deps)) return;
      const next = { deps, cleanup: undefined as (() => void) | undefined };
      hooks.values[index] = next;
      hooks.pendingEffects.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
    },
    useImperativeHandle: (ref: { current: unknown }, create: () => unknown) => {
      ref.current = create();
    },
  };
});
vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {},
}));
vi.mock("../i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../store/reader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/reader")>();
  return {
    ...actual,
    useReaderStore: (selector: (state: ReturnType<typeof actual.useReaderStore.getState>) => unknown) =>
      selector(actual.useReaderStore.getState()),
  };
});

interface ReaderNodeProps {
  children?: ReactNode;
  className?: string;
  pageNumber?: number;
  progress?: number;
  ref?: { current: unknown };
  onScroll?: () => void;
  onSeek?: (progress: number) => void;
  onCommit?: () => void;
  onRenderError?: (error: unknown) => void;
  onRendered?: (page: number, height: number) => void;
}

function findNode(
  tree: ReactNode,
  match: (props: ReaderNodeProps) => boolean,
): ReactElement<ReaderNodeProps> | undefined {
  if (!isValidElement<ReaderNodeProps>(tree)) return undefined;
  if (match(tree.props)) return tree;
  for (const child of Children.toArray(tree.props.children)) {
    const found = findNode(child, match);
    if (found) return found;
  }
  return undefined;
}

describe("PDF progress readiness", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    hooks.cursor = 0;
    hooks.dirty = false;
    hooks.values = [];
    hooks.pendingEffects = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function mountReader({ initialProgress = 0, pageReader = false } = {}) {
    let resolveDocument!: (document: { numPages: number }) => void;
    let rejectDocument!: (error: Error) => void;
    const documentPromise = new Promise<{ numPages: number }>((resolve, reject) => {
      resolveDocument = resolve;
      rejectDocument = reject;
    });
    vi.mocked(getDocument).mockReturnValue({
      promise: documentPromise,
      destroy: vi.fn(),
    } as unknown as ReturnType<typeof getDocument>);
    const frames: Array<() => void> = [];
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
      getComputedStyle: () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0", columnGap: "16" }),
    });
    const viewport = {
      clientHeight: 300,
      clientWidth: 300,
      scrollHeight: 300,
      scrollWidth: 300,
      scrollTop: 0,
      scrollTo: ({ top }: { top: number }) => { viewport.scrollTop = top; },
      scrollBy: vi.fn(),
    };
    const ref = { current: null as ReaderContentHandle | null };
    const onProgressChange = vi.fn();
    const props: ComponentProps<typeof PdfReaderContent> = {
      dataUrl: "data:application/pdf,%25PDF-1.4",
      generalSettings: { ...READER_GENERAL_DEFAULTS, pageReader },
      initialProgress,
      onProgressChange,
    };
    const renderComponent = (PdfReaderContent as unknown as {
      render: (props: ComponentProps<typeof PdfReaderContent>, ref: { current: ReaderContentHandle | null }) => ReactNode;
    }).render;
    let tree: ReactNode;
    const render = () => {
      for (let pass = 0; pass < 20; pass += 1) {
        hooks.cursor = 0;
        hooks.dirty = false;
        tree = renderComponent(props, ref);
        const viewportNode = findNode(tree, (node) => node.className?.startsWith("norea-pdf-reader-viewport") === true)!;
        viewportNode.props.ref!.current = viewport;
        const wrap = findNode(tree, (node) => node.className === "norea-pdf-reader-page-wrap")!;
        wrap.props.ref!.current = viewport;
        hooks.pendingEffects.splice(0).forEach((effect) => effect());
        frames.splice(0).forEach((frame) => frame());
        if (!hooks.dirty && frames.length === 0) return;
      }
      throw new Error("PDF reader did not settle.");
    };
    dispose = () => {
      for (const value of hooks.values) {
        if (value && typeof value === "object" && "cleanup" in value && typeof value.cleanup === "function") value.cleanup();
      }
      hooks.values = [];
    };
    render();
    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
      render();
    };
    return {
      ref,
      viewport,
      onProgressChange,
      resolveDocument,
      rejectDocument,
      render,
      settle,
      page: (number = 1) => findNode(tree, (node) => node.pageNumber === number)!.props,
      seekbar: () => findNode(tree, (node) => typeof node.onSeek === "function")!.props,
      scroll: () => findNode(tree, (node) => typeof node.onScroll === "function")!.props.onScroll!(),
    };
  }

  it.each([false, true])("does not complete an unrendered PDF (paged: %s)", async (pageReader) => {
    const reader = mountReader({ pageReader });
    reader.resolveDocument({ numPages: 1 });
    await reader.settle();
    reader.scroll();
    reader.seekbar().onSeek!(100);
    reader.seekbar().onCommit!();
    expect(reader.ref.current!.completeIfAtEnd()).toBe(false);
    vi.advanceTimersByTime(400);
    dispose?.();
    expect(reader.onProgressChange).not.toHaveBeenCalled();
  });

  it("preserves saved progress after a document-load failure", async () => {
    const reader = mountReader({ initialProgress: 37 });
    reader.rejectDocument(new Error("Invalid PDF structure"));
    await reader.settle();
    reader.scroll();
    expect(reader.ref.current!.completeIfAtEnd()).toBe(false);
    expect(reader.seekbar().progress).toBe(37);
    vi.advanceTimersByTime(400);
    dispose?.();
    expect(reader.onProgressChange).not.toHaveBeenCalled();
  });

  it("does not save 100% when a loaded document fails to render its page", async () => {
    const reader = mountReader();
    reader.resolveDocument({ numPages: 1 });
    await reader.settle();
    reader.page().onRenderError!(new Error("Bad (uncompressed) XRef entry: 4R"));
    reader.render();
    reader.scroll();
    reader.seekbar().onSeek!(100);
    reader.seekbar().onCommit!();
    expect(reader.ref.current!.completeIfAtEnd()).toBe(false);
    expect(reader.seekbar().progress).toBe(0);
    vi.advanceTimersByTime(400);
    dispose?.();
    expect(reader.onProgressChange).not.toHaveBeenCalled();
  });

  it("cancels a pending completion save immediately on a render error", async () => {
    const reader = mountReader();
    reader.resolveDocument({ numPages: 1 });
    await reader.settle();
    reader.page().onRendered!(1, 200);
    reader.render();
    expect(reader.seekbar().progress).toBe(100);
    expect(reader.onProgressChange).not.toHaveBeenCalled();
    reader.page().onRenderError!(new Error("Page rendering failed"));
    expect(reader.ref.current!.completeIfAtEnd()).toBe(false);
    vi.advanceTimersByTime(400);
    reader.render();
    expect(reader.seekbar().progress).toBe(0);
    dispose?.();
    expect(reader.onProgressChange).not.toHaveBeenCalled();
  });

  it.each([false, true])("allows completion after successful page rendering (paged: %s)", async (pageReader) => {
    const reader = mountReader({ pageReader });
    reader.resolveDocument({ numPages: 1 });
    await reader.settle();
    reader.page().onRendered!(1, 200);
    reader.render();
    expect(reader.ref.current!.completeIfAtEnd()).toBe(true);
    expect(reader.onProgressChange).toHaveBeenLastCalledWith(100);
  });

  it("does not complete a virtualized final page that has not rendered", async () => {
    const reader = mountReader();
    reader.viewport.scrollHeight = 932;
    reader.resolveDocument({ numPages: 3 });
    await reader.settle();
    reader.page(1).onRendered!(1, 300);
    reader.page(2).onRendered!(2, 300);
    reader.render();
    reader.viewport.scrollTop = 632;
    reader.scroll();
    expect(reader.ref.current!.completeIfAtEnd()).toBe(false);
    vi.advanceTimersByTime(400);
    expect(reader.onProgressChange).not.toHaveBeenCalled();
  });
});
