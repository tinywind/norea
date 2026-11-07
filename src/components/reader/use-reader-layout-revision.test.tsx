import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountBackNavigationHarness, type BackNavigationHarness } from "../../lib/android-back-navigation.test-support";
import { useReaderLayoutRevision } from "./use-reader-layout-revision";

let harness: BackNavigationHarness;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let content: EventTarget & { ownerDocument: { fonts: EventTarget & { ready: Promise<unknown> } } };
let revision: number;
let html: string;
let resolveFonts: () => void;
let contentRef: { current: HTMLDivElement };

function Probe() {
  revision = useReaderLayoutRevision(contentRef, html);
  return null;
}
async function flushFrames() {
  await harness.run(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
}
beforeEach(() => {
  harness = mountBackNavigationHarness();
  frames = new Map();
  frameId = 0;
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const fonts = Object.assign(new EventTarget(), { ready: new Promise<void>(resolve => { resolveFonts = resolve; }) });
  content = Object.assign(new EventTarget(), { ownerDocument: { fonts } });
  contentRef = { current: content as unknown as HTMLDivElement };
  html = "<p>Next</p>";
  revision = -1;
});
afterEach(async () => { await harness.unmount(); vi.restoreAllMocks(); });

it("coalesces local media load/error signals and remeasures when fonts finish", async () => {
  await harness.render(<Probe />);
  expect(revision).toBe(0);
  content.dispatchEvent(new Event("load"));
  content.dispatchEvent(new Event("error"));
  expect(frames.size).toBe(1);
  await flushFrames();
  expect(revision).toBe(1);
  content.ownerDocument.fonts.dispatchEvent(new Event("loadingdone"));
  await flushFrames();
  expect(revision).toBe(2);
  await harness.run(resolveFonts);
  await flushFrames();
  expect(revision).toBe(3);
});

it("cancels old frames when the body changes and ignores completion after unmount", async () => {
  await harness.render(<Probe />);
  content.dispatchEvent(new Event("load"));
  html = "<p>Replacement</p>";
  await harness.render(<Probe />);
  expect(frames.size).toBe(0);
  content.dispatchEvent(new Event("load"));
  expect(frames.size).toBe(1);
  await harness.render(null);
  await harness.run(resolveFonts);
  content.dispatchEvent(new Event("load"));
  expect(frames.size).toBe(0);
  expect(revision).toBe(0);
});
