import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({ restart: vi.fn() }));
vi.mock("../../db/client", () => ({ startWorkMetadataRecovery: mocks.restart }));
vi.mock("../../lib/work-metadata", () => ({ subscribeWorkMetadataChanges: () => () => undefined }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useStorageRecoveryStore } from "../../store/storage-recovery";
import { StorageRecoveryBanner } from "./StorageRecovery";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  useStorageRecoveryStore.setState({ status: "idle", progress: null, error: null });
});

function BannerProbe() {
  tree = StorageRecoveryBanner();
  return null;
}

async function render() {
  harness = mountBackNavigationHarness();
  await harness.render(<BannerProbe />);
  const elements = collectElements(tree);
  return {
    button: (label: string) => elements.find((element) => element.props.children === label),
    text: (label: string) => elements.some((element) => element.props.children === label),
    progress: elements.some((element) => "value" in element.props),
  };
}

it("shows nothing while recovery is idle", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<BannerProbe />);
  expect(tree).toBeNull();
});

it("shows progress without dismissal while recovery runs", async () => {
  useStorageRecoveryStore.setState({ status: "scanning" });
  const banner = await render();
  expect(banner.text("storageRecovery.title")).toBe(true);
  expect(banner.progress).toBe(true);
  expect(banner.button("storageRecovery.dismiss")).toBeUndefined();
});

it("offers Retry and keeps the raw error under Details when recovery fails", async () => {
  useStorageRecoveryStore.setState({ status: "error", error: "EACCES: /storage/emulated/0" });
  const banner = await render();
  expect(banner.text("storageRecovery.failed")).toBe(true);
  expect(banner.text("common.details")).toBe(true);
  (banner.button("common.retry")!.props.onClick as () => void)();
  expect(mocks.restart).toHaveBeenCalledWith(true);
  expect(banner.button("storageRecovery.dismiss")).toBeDefined();
});

it("dismisses a completed recovery", async () => {
  useStorageRecoveryStore.setState({ status: "complete" });
  const banner = await render();
  expect(banner.button("common.retry")).toBeUndefined();
  await harness!.run(() => (banner.button("storageRecovery.dismiss")!.props.onClick as () => void)());
  expect(useStorageRecoveryStore.getState().status).toBe("idle");
});
