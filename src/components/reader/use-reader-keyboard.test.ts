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

describe("reader keyboard ownership", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function mountKeyboard(readerSettingsOpen = false) {
    const target = new KeyboardTarget();
    const content = {
      completeIfAtEnd: vi.fn(() => false),
      patchMediaElements: vi.fn(),
      scrollByPage: vi.fn(),
      scrollToStart: vi.fn(),
    };
    const closeReaderSettingsPanel = vi.fn();
    const handleReaderActivity = vi.fn();
    vi.stubGlobal("Element", KeyboardTarget);
    vi.stubGlobal("HTMLElement", KeyboardTarget);
    vi.stubGlobal("window", target);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useReaderKeyboard({
      active: true,
      readerSettingsOpen,
      contentRef: { current: content },
      closeReaderSettingsPanel,
      handleReaderActivity,
      handleReaderBack: vi.fn(() => true),
    });
    dispose = vi.mocked(useEffect).mock.calls[0]![0]() as () => void;
    return { target, content, closeReaderSettingsPanel, handleReaderActivity };
  }

  function keyEvent(key: string) {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperty(event, "key", { value: key });
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

  it("closes reader settings with Escape without paging", () => {
    const { target, content, closeReaderSettingsPanel } = mountKeyboard(true);
    target.dispatchEvent(keyEvent("Escape"));

    expect(closeReaderSettingsPanel).toHaveBeenCalledOnce();
    expect(content.scrollByPage).not.toHaveBeenCalled();
  });

  it("removes its paging listener on unmount", () => {
    const { target, content } = mountKeyboard();
    dispose?.();
    target.dispatchEvent(keyEvent("ArrowRight"));

    expect(content.scrollByPage).not.toHaveBeenCalled();
  });
});
