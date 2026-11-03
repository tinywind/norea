import { act, type PointerEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "./use-long-press";

type LongPress = ReturnType<typeof useLongPress>;

let longPress: LongPress;
let root: Root;

function Probe({ onLongPress }: { onLongPress?: () => void }) {
  longPress = useLongPress(onLongPress, 450);
  return null;
}

async function render(onLongPress?: () => void) {
  await act(async () => root.render(<Probe onLongPress={onLongPress} />));
}

async function run(callback: () => void) {
  await act(async () => callback());
}

function pointer(button = 0) {
  return { button } as PointerEvent<HTMLElement>;
}

beforeEach(() => {
  vi.useFakeTimers();
  const document = {
    nodeType: 9, activeElement: null, body: null as unknown,
    documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {},
  };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    document,
    HTMLIFrameElement: class {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: number) => clearTimeout(id),
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Node", class {});
  root = createRoot(container as unknown as Element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("long press", () => {
  it("shows the held state for the long-press window, then fires once", async () => {
    const onLongPress = vi.fn();
    await render(onLongPress);
    await run(() => longPress.handlers.onPointerDown(pointer()));
    expect(longPress.pressing).toBe(true);

    await run(() => vi.advanceTimersByTime(449));
    expect(longPress.pressing).toBe(true);
    expect(onLongPress).not.toHaveBeenCalled();

    await run(() => vi.advanceTimersByTime(1));
    expect(longPress.pressing).toBe(false);
    expect(onLongPress).toHaveBeenCalledOnce();
    expect(longPress.consumeFired()).toBe(true);
    expect(longPress.consumeFired()).toBe(false);
  });

  it.each(["onPointerUp", "onPointerLeave", "onPointerCancel"] as const)(
    "drops the held state and the long press on %s",
    async (end) => {
      const onLongPress = vi.fn();
      await render(onLongPress);
      await run(() => longPress.handlers.onPointerDown(pointer()));
      await run(() => longPress.handlers[end]());
      expect(longPress.pressing).toBe(false);
      await run(() => vi.advanceTimersByTime(1000));
      expect(onLongPress).not.toHaveBeenCalled();
      expect(longPress.fired()).toBe(false);
    },
  );

  it("ignores secondary buttons and presses without a long-press action", async () => {
    const onLongPress = vi.fn();
    await render(onLongPress);
    await run(() => longPress.handlers.onPointerDown(pointer(2)));
    expect(longPress.pressing).toBe(false);

    await render(undefined);
    await run(() => longPress.handlers.onPointerDown(pointer()));
    expect(longPress.pressing).toBe(false);
    await run(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
