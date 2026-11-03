import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "./android-back-navigation.test-support";
import { useNearEnd } from "./use-near-end";

interface FakeObserver {
  callback: (entries: { isIntersecting: boolean }[]) => void;
  disconnected: boolean;
  options: IntersectionObserverInit | undefined;
  targets: unknown[];
}

let observers: FakeObserver[];
let harness: BackNavigationHarness | undefined;
let ref: ((element: Element | null) => void) | undefined;
const element = {} as Element;

class FakeIntersectionObserver {
  private readonly record: FakeObserver;
  constructor(
    callback: FakeObserver["callback"],
    options?: IntersectionObserverInit,
  ) {
    this.record = { callback, disconnected: false, options, targets: [] };
    observers.push(this.record);
  }
  observe(target: unknown) {
    this.record.targets.push(target);
  }
  disconnect() {
    this.record.disconnected = true;
  }
}

function Probe({ enabled, onNearEnd }: { enabled: boolean; onNearEnd: () => void }) {
  ref = useNearEnd(enabled, onNearEnd);
  return null;
}

async function render(enabled: boolean, onNearEnd: () => void, active = true) {
  harness ??= mountBackNavigationHarness();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  await harness.render(<Probe enabled={enabled} onNearEnd={onNearEnd} />, { active });
}

const live = () => observers.filter((observer) => !observer.disconnected);
/** Delivers entries the way the browser does: never after disconnect. */
function fire(observer: FakeObserver, isIntersecting: boolean) {
  if (!observer.disconnected) observer.callback([{ isIntersecting }]);
}

beforeEach(() => {
  observers = [];
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

it("requests once when the end comes near, then waits to be re-armed", async () => {
  const onNearEnd = vi.fn();
  await render(true, onNearEnd);
  await harness!.run(() => ref!(element));

  expect(live()).toHaveLength(1);
  expect(live()[0]!.targets).toEqual([element]);
  expect(live()[0]!.options?.rootMargin).toBe("0px 0px 100% 0px");
  const observer = live()[0]!;
  fire(observer, false);
  expect(onNearEnd).not.toHaveBeenCalled();

  fire(observer, true);
  fire(observer, true);
  expect(onNearEnd).toHaveBeenCalledOnce();
  expect(observer.disconnected).toBe(true);
});

it("does not observe while a request is in flight or the list has ended, and re-arms after", async () => {
  const onNearEnd = vi.fn();
  await render(true, onNearEnd);
  await harness!.run(() => ref!(element));
  fire(live()[0]!, true);

  await render(false, onNearEnd);
  expect(live()).toHaveLength(0);

  await render(true, onNearEnd);
  expect(live()).toHaveLength(1);
  fire(live()[0]!, true);
  expect(onNearEnd).toHaveBeenCalledTimes(2);
});

it("never triggers from a page slot that is not shown", async () => {
  const onNearEnd = vi.fn();
  await render(true, onNearEnd, false);
  await harness!.run(() => ref!(element));
  expect(observers).toHaveLength(0);
});
