import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FilterTypes, type Filters } from "../lib/plugins/filterTypes";
import { PluginFilters } from "./PluginFilters";

describe("PluginFilters", () => {
  it("shows the label for a selected picker option with an empty value", () => {
    const schema: Filters = {
      status: {
        type: FilterTypes.Picker,
        label: "Status",
        value: "",
        options: [
          { label: "Ongoing", value: "" },
          { label: "Completed", value: "completed" },
        ],
      },
    };

    const html = renderToStaticMarkup(
      <MantineProvider>
        <PluginFilters
          schema={schema}
          values={{ status: { type: FilterTypes.Picker, value: "" } }}
          onChange={vi.fn()}
        />
      </MantineProvider>,
    );

    expect(html).toMatch(/role="combobox"[^>]*value="Ongoing"/);
  });
});
