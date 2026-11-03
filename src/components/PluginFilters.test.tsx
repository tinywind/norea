import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FilterTypes, type Filters } from "../lib/plugins/filterTypes";
import { nextExcludableState, PluginFilters } from "./PluginFilters";

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

describe("PluginFilters excludable options", () => {
  const schema: Filters = {
    genres: {
      type: FilterTypes.ExcludableCheckboxGroup,
      label: "Genres",
      value: { include: [], exclude: [] },
      options: [
        { label: "Action", value: "action" },
        { label: "Drama", value: "drama" },
        { label: "Horror", value: "horror" },
      ],
    },
  };

  it("shows one chip per option whose name states include, exclude or neither", () => {
    const $ = load(
      renderToStaticMarkup(
        <MantineProvider>
          <PluginFilters
            schema={schema}
            values={{
              genres: {
                type: FilterTypes.ExcludableCheckboxGroup,
                value: { include: ["action"], exclude: ["horror"] },
              },
            }}
            onChange={vi.fn()}
          />
        </MantineProvider>,
      ),
    );

    expect($('[role="group"] button').map((_, button) => $(button).attr("aria-label")).get()).toEqual([
      "Action: Included",
      "Drama: Any",
      "Horror: Excluded",
    ]);
    expect($('[role="radio"], [role="radiogroup"]')).toHaveLength(0);
  });

  it("cycles a chip from neither to include to exclude and back", () => {
    expect(nextExcludableState("")).toBe("+");
    expect(nextExcludableState("+")).toBe("-");
    expect(nextExcludableState("-")).toBe("");
  });
});
