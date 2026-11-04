import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChipButton } from "./ChipButton";
import { FilterIcon } from "./ui/icons";

describe("ChipButton", () => {
  it("renders a toggle chip whose pressed state shows a leading check", () => {
    const off = renderToStaticMarkup(<ChipButton selected={false}>Unread</ChipButton>);
    const on = renderToStaticMarkup(<ChipButton selected>Unread</ChipButton>);
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain("<svg");
    expect(off).not.toContain("data-leading");
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("<svg");
    expect(on).toContain('data-leading="true"');
  });

  it("renders an action chip without a pressed state, with its icons and tone", () => {
    const markup = renderToStaticMarkup(
      <ChipButton icon={<FilterIcon />} tone="accent" trailingIcon={<FilterIcon />}>
        Filters
      </ChipButton>,
    );
    expect(markup).not.toContain("aria-pressed");
    expect(markup).toContain('type="button"');
    expect(markup).toContain('data-tone="accent"');
    expect(markup).toContain('data-leading="true"');
    expect(markup).toContain('data-trailing="true"');
    expect(markup).toMatch(/class="norea-chip norea-state-layer"/);
  });
});
