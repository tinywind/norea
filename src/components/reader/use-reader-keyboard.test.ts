import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReaderKeyboard } from "./use-reader-keyboard";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
}));

class KeyboardTarget extends EventTarget {
  closest = vi.fn().mockReturnValue(null);
  isContentEditable = false;
}

interface Modifiers {
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

describe("reader keyboard ownership", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function mountKeyboard(
    options: { overlayOpen?: boolean; modalOverlayOpen?: boolean; chromeDismissible?: boolean } = {},
  ) {
    const target = new KeyboardTarget();
    const content = {
      completeIfAtEnd: vi.fn(() => false),
      patchMediaElements: vi.fn(),
      scrollByPage: vi.fn(),
      scrollToStart: vi.fn(),
    };
    const closeTopReaderOverlay = vi.fn(() => options.overlayOpen ?? false);
    const handleReaderActivity = vi.fn();
    const handleReaderBack = vi.fn(() => true);
    const hideReaderChrome = vi.fn();
    const openAdjacentChapter = vi.fn();
    vi.stubGlobal("Element", KeyboardTarget);
    vi.stubGlobal("HTMLElement", KeyboardTarget);
    vi.stubGlobal("window", target);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useReaderKeyboard({
      active: true,
      contentRef: { current: content },
      closeTopReaderOverlay,
      modalOverlayOpen: options.modalOverlayOpen ?? false,
      readerChromeDismissible: options.chromeDismissible ?? false,
      hideReaderChrome,
      handleReaderActivity,
      handleReaderBack,
      openAdjacentChapter,
    });
    dispose = vi.mocked(useEffect).mock.calls[0]![0]() as () => void;
    return {
      target,
      content,
      closeTopReaderOverlay,
      handleReaderActivity,
      handleReaderBack,
      hideReaderChrome,
      openAdjacentChapter,
    };
  }

  function keyEvent(key: string, modifiers: Modifiers = {}) {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    Object.defineProperty(event, "ctrlKey", { value: modifiers.ctrlKey ?? false });
    Object.defineProperty(event, "altKey", { value: modifiers.altKey ?? false });
    Object.defineProperty(event, "metaKey", { value: false });
    Object.defineProperty(event, "shiftKey", { value: modifiers.shiftKey ?? false });
    return event;
  }

  it.each(["ArrowLeft", "ArrowRight", "Home"])(
    "leaves %s to a control that already handled it",
    (key) => {
      const { target, content, handleReaderActivity } = mountKeyboard();
      const event = keyEvent(key);
      event.preventDefault();
      target.dispatchEvent(event);

      expect(content.scrollByPage).not.toHaveBeenCalled();
      expect(content.scrollToStart).not.toHaveBeenCalled();
      expect(handleReaderActivity).not.toHaveBeenCalled();
    },
  );

  it("leaves unconsumed keys inside an interactive control to that control", () => {
    const { target, content } = mountKeyboard();
    target.closest.mockReturnValue(target);
    const event = keyEvent("PageDown");
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(content.scrollByPage).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowRight", 1],
    ["PageUp", -1],
  ])("preserves %s paging on the reading surface", (key, direction) => {
    const { target, content } = mountKeyboard();
    const event = keyEvent(String(key));
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(content.scrollByPage).toHaveBeenCalledOnce();
    expect(content.scrollByPage).toHaveBeenCalledWith(direction, `key-${key}`);
  });

  it.each([
    [" ", 1],
    ["ArrowDown", 1],
    ["PageDown", 1],
    ["ArrowUp", -1],
    ["ArrowLeft", -1],
  ])("pages with %j in direction %i", (key, direction) => {
    const { target, content, handleReaderActivity } = mountKeyboard();
    target.dispatchEvent(keyEvent(String(key)));

    expect(content.scrollByPage).toHaveBeenCalledWith(direction, `key-${key}`);
    expect(handleReaderActivity).toHaveBeenCalledOnce();
  });

  it("pages back with Shift+Space", () => {
    const { target, content } = mountKeyboard();
    target.dispatchEvent(keyEvent(" ", { shiftKey: true }));

    expect(content.scrollByPage).toHaveBeenCalledWith(-1, "key- ");
  });

  it("returns to the chapter start with Home", () => {
    const { target, content } = mountKeyboard();
    target.dispatchEvent(keyEvent("Home"));

    expect(content.scrollToStart).toHaveBeenCalledOnce();
  });

  it("closes the topmost overlay with Escape before anything else", () => {
    const { target, content, handleReaderBack, hideReaderChrome } = mountKeyboard({
      overlayOpen: true,
      chromeDismissible: true,
    });
    target.dispatchEvent(keyEvent("Escape"));

    expect(hideReaderChrome).not.toHaveBeenCalled();
    expect(handleReaderBack).not.toHaveBeenCalled();
    expect(content.scrollByPage).not.toHaveBeenCalled();
  });

  it("hides dismissible chrome with Escape before leaving the reader", () => {
    const { target, handleReaderBack, hideReaderChrome } = mountKeyboard({
      chromeDismissible: true,
    });
    target.dispatchEvent(keyEvent("Escape"));

    expect(hideReaderChrome).toHaveBeenCalledOnce();
    expect(handleReaderBack).not.toHaveBeenCalled();
  });

  it("leaves the reader with Escape when nothing else is open", () => {
    const { target, content, handleReaderBack } = mountKeyboard();
    target.dispatchEvent(keyEvent("Escape"));

    expect(handleReaderBack).toHaveBeenCalledOnce();
    expect(content.scrollByPage).not.toHaveBeenCalled();
  });

  it("leaves Escape to an open menu or text field", () => {
    const { target, handleReaderBack, closeTopReaderOverlay } = mountKeyboard();
    target.closest.mockReturnValue(target);
    const event = keyEvent("Escape");
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(closeTopReaderOverlay).not.toHaveBeenCalled();
    expect(handleReaderBack).not.toHaveBeenCalled();
  });

  it("ignores paging keys while a modal reader overlay is open", () => {
    const { target, content, openAdjacentChapter } = mountKeyboard({ modalOverlayOpen: true });
    target.dispatchEvent(keyEvent("ArrowRight"));
    target.dispatchEvent(keyEvent("]"));

    expect(content.scrollByPage).not.toHaveBeenCalled();
    expect(openAdjacentChapter).not.toHaveBeenCalled();
  });

  it.each([
    ["]", {}, 1],
    ["[", {}, -1],
    ["ArrowRight", { ctrlKey: true }, 1],
    ["ArrowLeft", { ctrlKey: true }, -1],
  ] as const)("opens the adjacent chapter with %s %j", (key, modifiers, direction) => {
    const { target, content, openAdjacentChapter } = mountKeyboard();
    const event = keyEvent(key, modifiers);
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openAdjacentChapter).toHaveBeenCalledWith(direction);
    expect(content.scrollByPage).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowRight", { altKey: true }],
    ["ArrowRight", { shiftKey: true }],
    ["ArrowRight", { ctrlKey: true, shiftKey: true }],
    ["Home", { ctrlKey: true }],
  ] as const)("leaves %s %j to the platform", (key, modifiers) => {
    const { target, content, openAdjacentChapter } = mountKeyboard();
    const event = keyEvent(key, modifiers);
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(content.scrollByPage).not.toHaveBeenCalled();
    expect(content.scrollToStart).not.toHaveBeenCalled();
    expect(openAdjacentChapter).not.toHaveBeenCalled();
  });

  it("removes its paging listener on unmount", () => {
    const { target, content } = mountKeyboard();
    dispose?.();
    target.dispatchEvent(keyEvent("ArrowRight"));

    expect(content.scrollByPage).not.toHaveBeenCalled();
  });
});
