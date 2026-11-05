import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BatteryOptimizationSetting } from "./BatteryOptimizationSetting";

function render(): string {
  return renderToStaticMarkup(<MantineProvider><BatteryOptimizationSetting /></MantineProvider>);
}

function stubBridge(exempt: boolean): void {
  vi.stubGlobal("window", { __NoreaAndroidBatteryOptimization: { isIgnoring: () => exempt, request: vi.fn(() => true) } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BatteryOptimizationSetting", () => {
  it("renders nothing outside the Android host", () => {
    expect(render()).not.toContain("Battery optimization exemption");
  });

  it("offers the exemption request while Norea is optimized", () => {
    stubBridge(false);
    const markup = render();
    expect(markup).toContain('data-settings-label="Battery optimization exemption"');
    expect(markup).toContain(">Optimized<");
    expect(markup).toContain('aria-label="Request battery optimization exemption"');
  });

  it("shows the exemption without a request action once Android grants it", () => {
    stubBridge(true);
    const markup = render();
    expect(markup).toContain(">Exempt<");
    expect(markup).not.toContain("Request battery optimization exemption");
  });
});
