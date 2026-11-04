import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const updates = vi.hoisted(() => ({ buildInfo: null as { buildVersion: string | null } | null }));
vi.mock("./use-app-updates", () => ({
  canInstallUpdate: () => false,
  updateStatusLabel: () => "",
  useAppUpdates: () => ({ buildInfo: updates.buildInfo, busy: false, candidate: null, checking: false, installing: false }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { AboutSection } from "./AboutSection";

const render = () => renderToStaticMarkup(<MantineProvider><AboutSection /></MantineProvider>);

beforeEach(() => {
  updates.buildInfo = null;
});

it("leaves the version row without an empty chip when the build has no version", () => {
  expect(render()).not.toContain("norea-console-chip");
  updates.buildInfo = { buildVersion: null };
  expect(render()).not.toContain("norea-console-chip");
});

it("shows the build version when there is one", () => {
  updates.buildInfo = { buildVersion: "0.2.0" };
  expect(render()).toMatch(/norea-console-chip[^>]*>v0\.2\.0</);
});
