import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { BuildInfo } from "../../lib/update";

const updates = vi.hoisted(() => ({ buildInfo: null as BuildInfo | null }));
vi.mock("./use-app-updates", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-app-updates")>(),
  canInstallUpdate: () => false,
  updateStatusLabel: () => "",
  useAppUpdates: () => ({ buildInfo: updates.buildInfo, busy: false, candidate: null, checking: false, installing: false }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { AboutSection } from "./AboutSection";

const LOCAL_BUILD: BuildInfo = {
  appVersion: "0.2.0",
  buildChannel: null,
  buildTime: null,
  buildVersion: null,
  gitSha: null,
  githubRunAttempt: null,
  githubRunId: null,
  platform: "android-arm64",
  targetArch: "aarch64",
  targetFamily: "unix",
  targetOs: "android",
};

const render = () => renderToStaticMarkup(<MantineProvider><AboutSection /></MantineProvider>);
const chips = (markup: string) =>
  [...markup.matchAll(/norea-console-chip[^>]*>([^<]*)</g)].map(([, text]) => text);

beforeEach(() => {
  updates.buildInfo = null;
});

it("shows no version chip before the build details load", () => {
  expect(render()).not.toContain("norea-console-chip");
});

it("shows the app version and a local build label when no CI metadata is stamped", () => {
  updates.buildInfo = LOCAL_BUILD;
  expect(chips(render())).toEqual(["v0.2.0", "settings.about.version.localBuild"]);

  updates.buildInfo = { ...LOCAL_BUILD, gitSha: "abc1234" };
  expect(chips(render())).toEqual(["v0.2.0", "settings.about.version.localBuild · abc1234"]);
});

it("shows the app version with the dev channel and short commit for a CI dev build", () => {
  updates.buildInfo = {
    ...LOCAL_BUILD,
    buildChannel: "dev",
    buildTime: "2026-11-04T00:00:00Z",
    gitSha: "0123456789abcdef0123456789abcdef01234567",
  };
  expect(chips(render())).toEqual(["v0.2.0", "settings.about.version.devBuild · 0123456"]);
});

it("shows only the stamped version for an official release", () => {
  updates.buildInfo = {
    ...LOCAL_BUILD,
    buildChannel: "release",
    buildVersion: "0.2.1",
    gitSha: "0123456789abcdef0123456789abcdef01234567",
  };
  expect(chips(render())).toEqual(["v0.2.1"]);
});
