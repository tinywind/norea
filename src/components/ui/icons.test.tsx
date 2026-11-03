import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LibraryIcon } from "./icons";

describe("app icons", () => {
  it("render decorative icons at the shared size and stroke", () => {
    const markup = renderToStaticMarkup(<LibraryIcon />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('width="1.5rem"');
    expect(markup).toContain('height="1.5rem"');
    expect(markup).toContain('stroke-width="1.75"');
  });

  it("lets a call site override the defaults", () => {
    const markup = renderToStaticMarkup(
      <LibraryIcon aria-hidden={false} size="1rem" stroke={2} />,
    );

    expect(markup).toContain('aria-hidden="false"');
    expect(markup).toContain('width="1rem"');
    expect(markup).toContain('stroke-width="2"');
  });
});
