import { readFileSync } from "node:fs";
import { MantineProvider, Select, Switch } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextButton } from "./TextButton";
import { SettingsAdvancedGroup, SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { IconButton } from "./IconButton";

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
  it("puts every row description behind an info button and keeps it for screen readers", () => {
    for (const description of ["Use a pure black background.", LONG_DESCRIPTION]) {
      const markup = render(
        <SettingsFieldRow description={description} label="Storage folder">
          <span />
        </SettingsFieldRow>,
      );
      expect(markup).toMatch(/aria-label="About Storage folder"[^>]*aria-expanded="false"/);
      expect(markup).not.toContain("norea-settings-form-description");
      expect(markup).toContain(description);
    }
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

describe("settings row layout", () => {
  it("splits inline rows in half and fills the control half", () => {
    const css = readFileSync(new URL("../styles/settings.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.norea-settings-form-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.norea-settings-form-control \{[^}]*justify-items: stretch;[^}]*width: 100%;/);
  });

  it("keeps compact number fields small at the control half's right edge", () => {
    const css = readFileSync(new URL("../styles/settings.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.norea-settings-form-control \.norea-settings-compact-field \{[^}]*justify-self: end;[^}]*width: 8rem;/);
    expect(css).toMatch(/\.norea-settings-inline-controls > \.norea-settings-compact-field \{[^}]*flex: 0 0 auto;/);
  });
});

describe("inline controls", () => {
  it("marks a group of icon buttons as compact so phones keep it on the label's line", () => {
    const icons = render(
      <SettingsInlineControls>
        <IconButton label="Export">{null}</IconButton>
        <IconButton label="Import">{null}</IconButton>
      </SettingsInlineControls>,
    );
    expect(icons).toContain('data-compact="true"');
    const mixed = render(
      <SettingsInlineControls>
        <IconButton label="Export">{null}</IconButton>
        <TextButton>Import</TextButton>
      </SettingsInlineControls>,
    );
    expect(mixed).not.toContain("data-compact");
    const value = render(
      <SettingsInlineControls compact>
        <span className="norea-settings-inline-value">192.0.2.1</span>
        <IconButton label="Mark">{null}</IconButton>
      </SettingsInlineControls>,
    );
    expect(value).toContain('data-compact="true"');
  });
});
