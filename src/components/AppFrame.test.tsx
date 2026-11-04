import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateView } from "./AppFrame";
import { DownloadsIcon } from "./ui/icons";

function render(node: ReactNode): string {
  return renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>);
}

describe("StateView", () => {
  it("draws an empty state as a centered block with its icon, not an alert", () => {
    const markup = render(
      <StateView icon={DownloadsIcon} message="Downloads show up here." title="No downloads" />,
    );
    expect(markup).toContain('class="norea-empty-state"');
    expect(markup).toContain("norea-empty-state-icon");
    expect(markup).toMatch(/norea-empty-state-title">No downloads</);
    expect(markup).toMatch(/norea-empty-state-message">Downloads show up here.</);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("mantine-Alert");
  });

  it("fills the only action and outlines the first of two", () => {
    const only = render(
      <StateView action={{ label: "Check", onClick: () => undefined }} title="Caught up" />,
    );
    expect(only).toContain('data-variant="filled"');

    const two = render(
      <StateView
        action={{ label: "Check", onClick: () => undefined }}
        secondaryAction={{ label: "Open", onClick: () => undefined }}
        title="Caught up"
      />,
    );
    expect(two).toContain('data-variant="default"');
    expect(two).toContain('data-variant="subtle"');
    expect(two).not.toContain('data-variant="filled"');
  });

  it("keeps the alert for errors and warnings", () => {
    for (const color of ["danger", "warn"] as const) {
      const markup = render(<StateView color={color} message="Failed" title="Could not load" />);
      expect(markup, color).toContain("mantine-Alert");
      expect(markup, color).not.toContain("norea-empty-state");
    }
  });
});
