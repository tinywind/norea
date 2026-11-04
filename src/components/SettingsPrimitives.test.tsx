import { MantineProvider, Select, Switch } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextButton } from "./TextButton";
import { SettingsAdvancedGroup, SettingsFieldRow, SettingsSection } from "./SettingsPrimitives";

function render(node: ReactNode): string {
  return renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>);
}

const LONG_DESCRIPTION =
  "This description explains a setting in enough detail that it no longer fits on one short line below the label.";

describe("settings groups", () => {
  it("names a group with a plain heading that labels the section", () => {
    const markup = render(
      <SettingsSection title="Notifications">
        <SettingsFieldRow label="Show progress" />
      </SettingsSection>,
    );
    const headingId = /<h2[^>]*class="[^"]*norea-settings-group-title[^"]*"[^>]*id="([^"]+)"/.exec(markup)?.[1];
    expect(headingId).toBeTruthy();
    expect(markup).toMatch(new RegExp(`<section aria-labelledby="${headingId}" class="norea-settings-group" data-titled="true"`));
    expect(markup).not.toContain("norea-console-panel");
  });

  it("leaves an untitled group unlabelled", () => {
    const markup = render(
      <SettingsSection>
        <SettingsFieldRow label="Show progress" />
      </SettingsSection>,
    );
    expect(markup).toMatch(/<section class="norea-settings-group">/);
    expect(markup).not.toContain("norea-settings-group-header");
  });
});

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

function labelIdOf(markup: string, label: string): string {
  const match = new RegExp(`id="([^"]+)"[^>]*>${label}<`).exec(markup);
  if (!match) throw new Error(`No label element for ${label}`);
  return match[1];
}

describe("settings row control labels", () => {
  it("names a switch after the row label", () => {
    const markup = render(
      <SettingsFieldRow label="Keep screen on">
        <Switch checked={false} onChange={() => undefined} />
      </SettingsFieldRow>,
    );
    const labelId = labelIdOf(markup, "Keep screen on");
    expect(markup).toMatch(new RegExp(`<input[^>]*aria-labelledby="${labelId}"[^>]*role="switch"|<input[^>]*role="switch"[^>]*aria-labelledby="${labelId}"`));
  });

  it("names a select after the row label", () => {
    const markup = render(
      <SettingsFieldRow label="Language">
        <Select data={["English"]} value="English" />
      </SettingsFieldRow>,
    );
    const labelId = labelIdOf(markup, "Language");
    expect(markup).toMatch(new RegExp(`<input[^>]*aria-labelledby="${labelId}"`));
  });

  it("keeps a control's own name and leaves buttons alone", () => {
    const named = render(
      <SettingsFieldRow label="Autoplay">
        <Switch aria-label="Autoplay video" checked={false} onChange={() => undefined} />
      </SettingsFieldRow>,
    );
    expect(named).toContain('aria-label="Autoplay video"');
    expect(named).not.toContain("aria-labelledby");

    const button = render(
      <SettingsFieldRow label="Backup">
        <TextButton onClick={() => undefined}>Export</TextButton>
      </SettingsFieldRow>,
    );
    expect(button).not.toContain("aria-labelledby");
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
