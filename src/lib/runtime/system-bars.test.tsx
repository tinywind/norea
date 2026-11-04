import { afterEach, expect, it, vi } from "vitest";
import { mountBackNavigationHarness, type BackNavigationHarness } from "../android-back-navigation.test-support";
import { setAppSystemBarBackground, useReaderSystemBarBackground } from "./system-bars";

let harness: BackNavigationHarness | undefined;

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.unstubAllGlobals();
});

it("chooses dark icons for light backgrounds and light icons for dark backgrounds", () => {
  const setLightSystemBars = vi.fn();
  vi.stubGlobal("window", { __NoreaAndroidWindow: { setLightSystemBars } });
  setAppSystemBarBackground("#ffffff");
  expect(setLightSystemBars).toHaveBeenLastCalledWith(true);
  setAppSystemBarBackground("#20211e");
  expect(setLightSystemBars).toHaveBeenLastCalledWith(false);
});

it("keeps the active reader's colors until it leaves, then restores the current app colors", async () => {
  const setLightSystemBars = vi.fn();
  harness = mountBackNavigationHarness();
  window.__NoreaAndroidWindow = { getMetrics: () => "{}", setLightSystemBars };
  function Probe({ active, background }: { active: boolean; background: string }) {
    useReaderSystemBarBackground(background, active);
    return null;
  }
  setAppSystemBarBackground("#ffffff");
  await harness.render(<Probe active background="#20211e" />);
  expect(setLightSystemBars).toHaveBeenLastCalledWith(false);
  setAppSystemBarBackground("#fafafa");
  expect(setLightSystemBars).toHaveBeenLastCalledWith(false);
  await harness.render(<Probe active background="#ffffff" />);
  expect(setLightSystemBars).toHaveBeenLastCalledWith(true);
  setAppSystemBarBackground("#20211e");
  expect(setLightSystemBars).toHaveBeenLastCalledWith(true);
  await harness.render(<Probe active={false} background="#ffffff" />);
  expect(setLightSystemBars).toHaveBeenLastCalledWith(false);
});

it("does not require an Android bridge on desktop", () => {
  vi.stubGlobal("window", {});
  expect(() => setAppSystemBarBackground("#ffffff")).not.toThrow();
});
