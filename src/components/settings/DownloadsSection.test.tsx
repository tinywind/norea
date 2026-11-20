import { Select } from "@mantine/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));
vi.mock("../ui/ConfirmDialog", () => ({
  useConfirm: () => mocks.confirm,
}));
vi.mock("../ChapterCleanupPanel", () => ({ ChapterCleanupPanel: () => null }));
vi.mock("../AllFilesAccessSetting", () => ({ AllFilesAccessSetting: () => null }));
vi.mock("../BatteryOptimizationSetting", () => ({ BatteryOptimizationSetting: () => null }));
vi.mock("../runtime/StorageRecovery", () => ({ StorageRecoveryBanner: () => null }));
vi.mock("./NovelDownloadGoalSettings", () => ({ NovelDownloadGoalSettings: () => null }));
vi.mock("./DownloadRecoverySettings", () => ({ DownloadRecoverySettings: () => null }));
vi.mock("../../lib/chapter-media-storage", () => ({
  getChapterMediaStorageRoot: vi.fn(async () => null),
  selectChapterMediaStorageRoot: vi.fn(async () => null),
}));
vi.mock("../../lib/chapter-content-storage", () => ({
  restartChapterContentStorageMirrorSweep: vi.fn(),
}));
vi.mock("../../lib/tauri-runtime", () => ({
  isAndroidRuntime: () => false,
  isTauriRuntime: () => true,
}));

import { useContentSyncStore } from "../../store/content-sync";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { SettingsFieldRow } from "../SettingsPrimitives";
import { DownloadsSection } from "./DownloadsSection";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

beforeEach(() => {
  mocks.confirm.mockReset().mockResolvedValue(true);
  useContentSyncStore.setState({ serverUrl: "" });
  useDownloadGoalSettingsStore.setState({
    automaticGoal: { kind: "keep_ahead", count: 5 },
    automaticActiveWindow: 14,
    finishedChapterKeep: "off",
    finishedCleanupWithoutServer: false,
  });
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

async function renderSection() {
  let cleanupRowTree: ReactNode = null;
  function Probe() {
    tree = DownloadsSection({ isBusy: false });
    const cleanupComponent = collectElements(tree).find(
      (el) => typeof el.type === "function" && el.type.name === "FinishedChapterCleanupRow",
    );
    cleanupRowTree = cleanupComponent ? (cleanupComponent.type as () => ReactNode)() : null;
    return null;
  }
  if (harness) await harness.unmount();
  harness = mountBackNavigationHarness();
  await harness.render(<Probe />);
  return [...collectElements(tree), ...collectElements(cleanupRowTree)];
}

it("exposes keep-0, active window choices (7/14/30/unlimited), entire-goal notice, and no-server confirmation", async () => {
  const elements = await renderSection();
  const selects = elements.filter((el) => el.type === Select);

  const windowSelect = selects.find((el) => el.props.value === "14")!;
  expect((windowSelect.props.data as Array<{ value: string }>).map((item) => item.value)).toEqual([
    "7",
    "14",
    "30",
    "unlimited",
  ]);
  expect(windowSelect.props.disabled).toBe(false);
  (windowSelect.props.onChange as (value: string | null) => void)("unlimited");
  expect(useDownloadGoalSettingsStore.getState().automaticActiveWindow).toBe("unlimited");

  const cleanupSelect = selects.find((el) => el.props.value === "off")!;
  const cleanupChoices = cleanupSelect.props.data as Array<{ value: string; label: string }>;
  expect(cleanupChoices.map((item) => item.value)).toEqual(["off", "0", "5", "10", "20"]);
  expect(cleanupChoices.find((item) => item.value === "0")?.label).toBe(
    "settings.downloads.finishedCleanup.keepZero",
  );

  // Choosing keep-0 without a content server requires confirmation.
  await (cleanupSelect.props.onChange as (value: string | null) => void)("0");
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(useDownloadGoalSettingsStore.getState().finishedChapterKeep).toBe(0);
  expect(useDownloadGoalSettingsStore.getState().finishedCleanupWithoutServer).toBe(true);

  // Notice appears only when automaticGoal is "entire" AND finishedChapterKeep !== "off".
  useDownloadGoalSettingsStore.setState({ automaticGoal: { kind: "entire" }, finishedChapterKeep: 0 });
  const withNotice = await renderSection();
  const cleanupRow = withNotice.find(
    (el) => el.type === SettingsFieldRow && el.props.label === "settings.downloads.finishedCleanup.label",
  )!;
  expect(cleanupRow.props.status).toBe("settings.downloads.finishedCleanup.entireGoalNotice");

  // Active window selector disables when automaticGoal is "none".
  useDownloadGoalSettingsStore.setState({ automaticGoal: { kind: "none" } });
  const disabledRender = await renderSection();
  const disabledWindowSelect = disabledRender
    .filter((el) => el.type === Select)
    .find((el) => el.props.value === "unlimited")!;
  expect(disabledWindowSelect.props.disabled).toBe(true);
});
