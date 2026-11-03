import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsAdvancedGroup, SettingsFieldRow } from "./SettingsPrimitives";

function render(node: ReactNode): string {
  return renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>);
}

const LONG_DESCRIPTION =
  "This description explains a setting in enough detail that it no longer fits on one short line below the label.";

describe("settings rows", () => {
  it("keeps a short description inline", () => {
    const markup = render(
      <SettingsFieldRow description="Use a pure black background." label="AMOLED black">
        <span />
      </SettingsFieldRow>,
    );
    expect(markup).not.toContain("norea-settings-form-info");
    expect(markup).not.toMatch(/norea-settings-form-description[^>]*hidden/);
  });

  it("moves a long description behind a collapsed info toggle", () => {
    const markup = render(
      <SettingsFieldRow description={LONG_DESCRIPTION} label="Storage folder">
        <span />
      </SettingsFieldRow>,
    );
    expect(markup).toMatch(/aria-label="About Storage folder"[^>]*aria-expanded="false"/);
    expect(markup).toMatch(/norea-settings-form-description[^>]*hidden=""/);
    expect(markup).toContain(LONG_DESCRIPTION);
  });

  it("shows row status and errors inline", () => {
    const markup = render(
      <SettingsFieldRow error="Failed to load" label="Status" status="Restart to apply">
        <span />
      </SettingsFieldRow>,
    );
    expect(markup).toMatch(/role="status"[^>]*>Restart to apply</);
    expect(markup).toMatch(/role="alert"[^>]*>Failed to load</);
  });
});

describe("advanced settings group", () => {
  it("starts collapsed and keeps its rows mounted", () => {
    const markup = render(
      <SettingsAdvancedGroup>
        <SettingsFieldRow label="Custom accent color" />
      </SettingsAdvancedGroup>,
    );
    expect(markup).toMatch(/aria-expanded="false"[^>]*class="norea-settings-advanced-toggle/);
    expect(markup).toContain(">Advanced<");
    expect(markup).toContain("Custom accent color");
  });

  it("opens by itself when a row inside needs attention", () => {
    const markup = render(
      <SettingsAdvancedGroup forceOpen label="Credentials">
        <SettingsFieldRow label="Username" />
      </SettingsAdvancedGroup>,
    );
    expect(markup).toMatch(/aria-expanded="true"[^>]*class="norea-settings-advanced-toggle/);
    expect(markup).toContain(">Credentials<");
  });
});
