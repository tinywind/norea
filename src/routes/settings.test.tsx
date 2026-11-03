import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

import { SettingsPage } from "./settings";

function renderSettings(section: string): string {
  return renderToStaticMarkup(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPage section={section} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("settings navigation section", () => {
  it("keeps the label switch and drops the retired tab switches", () => {
    const markup = renderSettings("app");

    expect(markup).toContain("Navigation labels");
    for (const label of ["History tab", "Updates tab", "Cache tab", "Tasks tab"]) {
      expect(markup).not.toContain(label);
    }
  });

  it("no longer offers pause reading history in library settings", () => {
    const markup = renderSettings("library");

    expect(markup).toContain("Default library category");
    expect(markup).not.toContain("Pause reading history");
  });
});
