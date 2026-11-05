import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({ convert: vi.fn() }));
vi.mock("../lib/local-cover", () => ({
  convertLocalCoverFile: mocks.convert,
  isLocalCoverSource: (value: unknown) => typeof value === "string" && value.startsWith("data:"),
  LOCAL_COVER_ACCEPT: "image/*",
  LOCAL_COVER_LIMITS: { fileBytes: 1024 * 1024 },
  LocalCoverError: class extends Error {
    constructor(readonly code: string) { super(code); }
  },
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { LocalCoverPicker } from "./LocalCoverPicker";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;
const onChange = vi.fn();
const onPendingChange = vi.fn();

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

function PickerProbe() {
  tree = LocalCoverPicker({ alt: "Cover", onChange, onPendingChange, value: "" });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

async function mount() {
  harness = mountBackNavigationHarness();
  await harness.render(<PickerProbe />);
}

const elements = () => collectElements(tree);
async function choose(name: string) {
  const input = elements().find((element) => element.type === "input")!;
  await harness!.run(() => {
    void (input.props.onChange as (event: unknown) => Promise<void>)({
      currentTarget: { files: [new File(["x"], name)], value: name },
    });
  });
}
const status = () => elements().find((element) => element.props.role === "status");
const alert = () => elements().find((element) => element.props.role === "alert");

it("shows a pending state while the chosen image converts", async () => {
  const conversion = deferred<string>();
  mocks.convert.mockReturnValue(conversion.promise);
  await mount();

  await choose("a.png");
  expect(status()).toBeDefined();
  expect(onPendingChange).toHaveBeenLastCalledWith(true);

  await harness!.run(() => conversion.resolve("data:a"));
  expect(onChange).toHaveBeenCalledWith("data:a");
  expect(status()).toBeUndefined();
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
});

it("ignores a slower result from an earlier selection", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  mocks.convert.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await mount();

  await choose("first.png");
  await choose("second.png");
  await harness!.run(() => second.resolve("data:second"));
  await harness!.run(() => first.resolve("data:first"));

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith("data:second");
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
});

it("drops an earlier selection's failure and keeps the later choice pending", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  mocks.convert.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await mount();

  await choose("first.png");
  await choose("second.png");
  await harness!.run(() => first.reject(new Error("unreadable")));

  expect(alert()).toBeUndefined();
  expect(status()).toBeDefined();
});

it("ignores a conversion that finishes after Clear", async () => {
  const conversion = deferred<string>();
  mocks.convert.mockReturnValue(conversion.promise);
  await mount();

  await choose("a.png");
  const clear = elements().find((element) => element.props.label === "library.localNovel.coverClear")!;
  await harness!.run(() => (clear.props.onClick as () => void)());
  await harness!.run(() => conversion.resolve("data:a"));

  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
  expect(status()).toBeUndefined();
});

it("announces a conversion failure as an alert", async () => {
  mocks.convert.mockRejectedValue(new Error("unreadable"));
  await mount();

  await choose("broken.png");

  expect(alert()?.props.children).toBe("library.localNovel.coverReadFailed");
  expect(onChange).not.toHaveBeenCalled();
});
