import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";
import { StartupSplash } from "./StartupSplash";

const STARTUP_PREFIXES = ["startup.", "storageSetup.", "pluginVpn.bootstrap."];

function startupCopy(messages: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(messages).filter(([key]) =>
      STARTUP_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  );
}

describe("StartupSplash", () => {
  it("shows the app icon, one neutral message and a spinner as a status", () => {
    const markup = renderToStaticMarkup(
      <MantineProvider>
        <StartupSplash />
      </MantineProvider>,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('src="/app-icon.svg"');
    expect(markup).toContain("Starting Norea…");
    expect(markup).toContain("mantine-Loader-root");
    expect(markup).not.toContain("media storage");
    expect(markup).not.toContain("plugin network");
  });
});

describe("startup copy", () => {
  it("defines the same startup keys in every locale", () => {
    expect(Object.keys(startupCopy(ko)).sort()).toEqual(
      Object.keys(startupCopy(en)).sort(),
    );
  });

  it("names the Android folder action by what it does", () => {
    for (const messages of [en, ko] as Record<string, string>[]) {
      expect(messages).not.toHaveProperty(["storageSetup.useAppStorage"]);
      expect(messages).not.toHaveProperty(["storageSetup.checking"]);
    }
    expect(en["storageSetup.selectExternalFolder"]).toBe("Select external folder");
  });

  it.each([
    ["en", en],
    ["ko", ko],
  ] as const)("keeps implementation terms out of the %s startup copy", (_, messages) => {
    for (const [key, value] of Object.entries(startupCopy(messages))) {
      expect(value, key).not.toMatch(/contents\/|trusted|proxy|신뢰|프록시/i);
    }
  });
});
