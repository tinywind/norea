import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "../lib/plugins/types";

vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/plugins/inputs", () => ({
  deletePluginInputValue: vi.fn(),
  getPluginInputValue: () => "stored-user",
  setPluginInputValue: vi.fn(),
}));

import { PluginSettingsEditor } from "./PluginSettingsEditor";

const plugin = {
  id: "demo",
  name: "Demo",
  pluginInputs: { username: { label: "Username", type: "text", value: "" } },
} as unknown as Plugin;

function render(onCancel?: () => void) {
  return load(renderToStaticMarkup(
    <MantineProvider>
      <PluginSettingsEditor onCancel={onCancel} plugin={plugin} />
    </MantineProvider>,
  ));
}

function button($: ReturnType<typeof load>, label: string) {
  return $("button").filter((_, element) => $(element).text() === label);
}

describe("PluginSettingsEditor", () => {
  it("starts from the stored values with Save disabled until something changes", () => {
    const $ = render();
    expect($("input[aria-label=Username]").attr("value")).toBe("stored-user");
    expect(button($, "common.save").attr("disabled")).toBeDefined();
  });

  it("offers Cancel next to Save when the host can close it", () => {
    expect(button(render(vi.fn()), "common.cancel")).toHaveLength(1);
    expect(button(render(), "common.cancel")).toHaveLength(0);
  });
});
