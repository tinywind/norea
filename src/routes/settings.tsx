import { useEffect, useState, type ReactNode } from "react";
import {
  Anchor,
  Box,
  ColorInput,
  Group,
  NumberInput,
  ScrollArea,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PageFrame } from "../components/AppFrame";
import { BrowseSettingsPanel } from "../components/BrowseSettingsPanel";
import { ConsoleChip } from "../components/ConsolePrimitives";
import { LibrarySettingsPanel } from "../components/LibrarySettingsPanel";
import { ReaderSettingsPanel } from "../components/ReaderSettingsPanel";
import {
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
  SettingsWideField,
} from "../components/SettingsPrimitives";
import { TextButton } from "../components/TextButton";
import {
  clearDownloadedChapterContent,
  clearLibraryMembership,
  clearReadingProgress,
  clearUpdatesTab,
} from "../db/queries/maintenance";
import {
  exportBackupToFile,
  importBackupFromFile,
} from "../lib/backup/io";
import { clearAllChapterMedia } from "../lib/chapter-media";
import { clearAllStoredChapterContentMirrors } from "../lib/chapter-content-storage";
import {
  getChapterMediaStorageRoot,
  selectChapterMediaStorageRoot,
} from "../lib/chapter-media-storage";
import { pluginManager } from "../lib/plugins/manager";
import { isAndroidRuntime } from "../lib/tauri-runtime";
import { enqueueMainTask } from "../lib/tasks/main-tasks";
import type { MainTaskKind } from "../lib/tasks/scheduler";
import {
  checkDevUpdate,
  checkOfficialUpdate,
  getBuildInfo,
  installUpdate,
  type BuildInfo,
  type UpdateCandidate,
  type UpdateChannel,
} from "../lib/update";
import { markUpdatesIndexDirty } from "../lib/updates/update-index-events";
import {
  formatDateTimeForLocale,
  SUPPORTED_APP_LOCALES,
  useTranslation,
  type AppLocale,
  type TranslationKey,
} from "../i18n";
import {
  DEFAULT_APPEARANCE,
  MAX_ANDROID_VIEW_SCALE_PERCENT,
  MAX_FONT_SCALE_PERCENT,
  MIN_ANDROID_VIEW_SCALE_PERCENT,
  MIN_FONT_SCALE_PERCENT,
  normalizeAppThemeId,
  normalizeAppThemeMode,
  useAppearanceStore,
} from "../store/appearance";
import { useBrowseStore } from "../store/browse";
import { useLibraryStore } from "../store/library";
import { LOG_LEVELS, type LogLevel, useLoggingStore } from "../store/logging";
import { useReaderStore } from "../store/reader";
import { useUserAgentStore } from "../store/user-agent";
import {
  normalizeTaskNotificationMode,
  useNotificationStore,
} from "../store/notifications";
import { APP_THEME_OPTIONS } from "../theme/md3";
import "../styles/settings.css";

type SettingsCategoryId =
  | "app"
  | "reader"
  | "library"
  | "browse"
  | "data"
  | "about";

interface SettingsCategory {
  content: ReactNode;
  id: SettingsCategoryId;
  title: string;
}

const LATEST_RELEASE_URL = "https://github.com/tinywind/norea/releases/latest";
const ROOT_FONT_SIZE_PX = 16;
const MIN_ROOT_FONT_SIZE_PX = Math.round(
  (ROOT_FONT_SIZE_PX * MIN_FONT_SCALE_PERCENT) / 100,
);
const MAX_ROOT_FONT_SIZE_PX = Math.round(
  (ROOT_FONT_SIZE_PX * MAX_FONT_SCALE_PERCENT) / 100,
);
const LOG_LEVEL_LABEL_KEYS: Record<LogLevel, TranslationKey> = {
  trace: "settings.about.logLevel.trace",
  debug: "settings.about.logLevel.debug",
  info: "settings.about.logLevel.info",
  warn: "settings.about.logLevel.warn",
  error: "settings.about.logLevel.error",
  off: "settings.about.logLevel.off",
};

const SETTINGS_TOAST_AUTO_CLOSE_MS = 5000;

async function clearDownloadedChapterContentAndMedia(): Promise<{
  rowsAffected: number;
}> {
  await clearAllStoredChapterContentMirrors();
  const result = await clearDownloadedChapterContent();
  await clearAllChapterMedia();
  return result;
}

type SettingsToastColor = "blue" | "green" | "red";

function showSettingsToast(
  color: SettingsToastColor,
  title: string,
  message?: string,
): void {
  notifications.show({
    color,
    title,
    message,
    autoClose: SETTINGS_TOAST_AUTO_CLOSE_MS,
  });
}

function showSettingsLoadingToast(
  id: string,
  title: string,
  message: string,
): void {
  notifications.show({
    id,
    color: "blue",
    title,
    message,
    loading: true,
    autoClose: false,
    withCloseButton: false,
  });
}

function updateSettingsToast(
  id: string,
  color: Exclude<SettingsToastColor, "blue">,
  title: string,
  message: string,
): void {
  notifications.update({
    id,
    color,
    title,
    message,
    loading: false,
    autoClose: SETTINGS_TOAST_AUTO_CLOSE_MS,
    withCloseButton: true,
  });
}

type UpdateBusy = `${UpdateChannel}:check` | `${UpdateChannel}:install`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSection(section: string | undefined): SettingsCategoryId {
  switch (section?.toLowerCase()) {
    case "reader":
      return "reader";
    case "library":
      return "library";
    case "browse":
      return "browse";
    case "data":
      return "data";
    case "about":
      return "about";
    case "app":
    default:
      return "app";
  }
}

function fontScalePercentToRootFontSize(fontScalePercent: number): number {
  return Math.round((ROOT_FONT_SIZE_PX * fontScalePercent) / 100);
}

function rootFontSizeToFontScalePercent(rootFontSize: unknown): number {
  return (Number(rootFontSize) / ROOT_FONT_SIZE_PX) * 100;
}

async function rehydrateImportedSettings(): Promise<void> {
  await Promise.all([
    useAppearanceStore.persist.rehydrate(),
    useBrowseStore.persist.rehydrate(),
    useLibraryStore.persist.rehydrate(),
    useNotificationStore.persist.rehydrate(),
    useReaderStore.persist.rehydrate(),
    useUserAgentStore.persist.rehydrate(),
  ]);
}

async function refreshImportedDataQueries(
  queryClient: QueryClient,
): Promise<void> {
  queryClient.removeQueries({ type: "inactive" });
  await queryClient.invalidateQueries({ refetchType: "active" });
}

function MediaStorageSettingsSection({ isBusy }: { isBusy: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mediaStorageRoot, setMediaStorageRoot] = useState<string | null>(null);
  const [mediaStorageBusy, setMediaStorageBusy] = useState(false);

  useEffect(() => {
    void getChapterMediaStorageRoot()
      .then(setMediaStorageRoot)
      .catch((error: unknown) => {
        showSettingsToast(
          "red",
          t("settings.data.mediaStorage.loadFailed", {
            error: describeError(error),
          }),
        );
      });
  }, [t]);

  async function chooseMediaStorageRoot(): Promise<void> {
    setMediaStorageBusy(true);
    try {
      const root = await selectChapterMediaStorageRoot();
      if (root) {
        setMediaStorageRoot(root);
        showSettingsToast(
          "green",
          t("settings.toast.saved"),
        );
        void queryClient.invalidateQueries({ queryKey: ["novel"] });
        void queryClient.invalidateQueries({ queryKey: ["category"] });
      }
    } catch (error) {
      showSettingsToast(
        "red",
        t("settings.data.mediaStorage.selectFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setMediaStorageBusy(false);
    }
  }

  return (
    <SettingsSection title={t("settings.data.mediaStorage.title")}>
      <SettingsFieldRow
        label={t("settings.data.mediaStorage.folder.label")}
        description={
          isAndroidRuntime()
            ? t("settings.data.mediaStorage.folder.androidDefaultDescription")
            : t("settings.data.mediaStorage.folder.description")
        }
        layout="stacked"
      >
        <SettingsWideField>
          <Text className="lnr-settings-path-value">
            {mediaStorageRoot ?? t("settings.data.mediaStorage.folder.empty")}
          </Text>
        </SettingsWideField>
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t("settings.data.mediaStorage.change.label")}
        description={
          isAndroidRuntime()
            ? t("settings.data.mediaStorage.change.androidDefaultDescription")
            : t("settings.data.mediaStorage.change.description")
        }
      >
        <TextButton
          loading={mediaStorageBusy}
          disabled={mediaStorageBusy || isBusy}
          onClick={() => {
            void chooseMediaStorageRoot();
          }}
        >
          {isAndroidRuntime()
            ? t("storageSetup.useAppStorage")
            : t("storageSetup.selectFolder")}
        </TextButton>
      </SettingsFieldRow>
    </SettingsSection>
  );
}

function AppSettingsSection({ isBusy }: { isBusy: boolean }) {
  const appearance = useAppearanceStore();
  const notificationSettings = useNotificationStore();
  const { t } = useTranslation();
  const showAndroidViewScale = isAndroidRuntime();

  return (
    <Stack gap="md">
      <SettingsSection
        title={t("settings.app.appearance.title")}
      >
        <SettingsFieldRow
          label={t("settings.app.themeMode.label")}
          description={t("settings.app.themeMode.description")}
        >
          <Select
            data={[
              { value: "system", label: t("settings.app.themeMode.system") },
              { value: "light", label: t("settings.app.themeMode.light") },
              { value: "dark", label: t("settings.app.themeMode.dark") },
            ]}
            value={appearance.themeMode}
            onChange={(themeMode) =>
              appearance.setThemeMode(normalizeAppThemeMode(themeMode))
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.appTheme.label")}
          description={t("settings.app.appTheme.description")}
        >
          <Select
            data={APP_THEME_OPTIONS}
            value={appearance.appThemeId}
            onChange={(appThemeId) =>
              appearance.setAppThemeId(normalizeAppThemeId(appThemeId))
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.customAccent.label")}
          description={t("settings.app.customAccent.description")}
        >
          <ColorInput
            value={appearance.customAccentColor}
            placeholder={t("settings.app.customAccent.placeholder")}
            onChange={appearance.setCustomAccentColor}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.amoled.label")}
          description={t("settings.app.amoled.description")}
        >
          <Switch
            checked={appearance.amoledBlack}
            onChange={(event) =>
              appearance.setAmoledBlack(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        {showAndroidViewScale ? (
          <SettingsFieldRow
            label={t("settings.app.androidViewScale.label")}
            description={t("settings.app.androidViewScale.description")}
          >
            <div className="lnr-settings-slider-control">
              <Text className="lnr-settings-slider-value">
                {appearance.androidViewScalePercent}%
              </Text>
              <Slider
                value={appearance.androidViewScalePercent}
                min={MIN_ANDROID_VIEW_SCALE_PERCENT}
                max={MAX_ANDROID_VIEW_SCALE_PERCENT}
                step={5}
                label={(value) => `${value}%`}
                marks={[
                  { value: MIN_ANDROID_VIEW_SCALE_PERCENT, label: "75%" },
                  { value: MAX_ANDROID_VIEW_SCALE_PERCENT, label: "100%" },
                ]}
                onChange={appearance.setAndroidViewScalePercent}
              />
            </div>
          </SettingsFieldRow>
        ) : null}
        <SettingsFieldRow
          label={t("settings.app.fontScale.label")}
          description={t("settings.app.fontScale.description")}
        >
          <NumberInput
            value={fontScalePercentToRootFontSize(appearance.fontScalePercent)}
            min={MIN_ROOT_FONT_SIZE_PX}
            max={MAX_ROOT_FONT_SIZE_PX}
            step={1}
            suffix="px"
            onChange={(rootFontSize) =>
              appearance.setFontScalePercent(
                rootFontSizeToFontScalePercent(rootFontSize),
              )
            }
          />
        </SettingsFieldRow>
      </SettingsSection>

      <MediaStorageSettingsSection isBusy={isBusy} />

      <SettingsSection
        title={t("settings.app.localization.title")}
      >
        <SettingsFieldRow
          label={t("settings.app.locale.label")}
          description={t("settings.app.locale.description")}
        >
          <Select
            data={SUPPORTED_APP_LOCALES.map((locale) => ({
              value: locale,
              label: t(locale === "ko" ? "locale.ko" : "locale.en"),
            }))}
            value={appearance.appLocale}
            onChange={(appLocale) =>
              appearance.setAppLocale(appLocale ?? DEFAULT_APPEARANCE.appLocale)
            }
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.app.notifications.title")}
      >
        <SettingsFieldRow
          label={t("settings.app.taskNotifications.label")}
          description={t("settings.app.taskNotifications.description")}
        >
          <Select
            data={[
              {
                value: "off",
                label: t("settings.app.taskNotifications.off"),
              },
              {
                value: "completion",
                label: t("settings.app.taskNotifications.completion"),
              },
              {
                value: "progress",
                label: t("settings.app.taskNotifications.progress"),
              },
            ]}
            value={notificationSettings.taskProgressMode}
            onChange={(taskProgressMode) =>
              notificationSettings.setTaskProgressMode(
                normalizeTaskNotificationMode(taskProgressMode),
              )
            }
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.app.navigation.title")}
      >
        <SettingsFieldRow
          label={t("settings.app.historyTab.label")}
          description={t("settings.app.historyTab.description")}
        >
          <Switch
            checked={appearance.showHistoryTab}
            onChange={(event) =>
              appearance.setShowHistoryTab(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.updatesTab.label")}
          description={t("settings.app.updatesTab.description")}
        >
          <Switch
            checked={appearance.showUpdatesTab}
            onChange={(event) =>
              appearance.setShowUpdatesTab(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.cacheTab.label")}
          description={t("settings.app.cacheTab.description")}
        >
          <Switch
            checked={appearance.showDownloadsTab}
            onChange={(event) =>
              appearance.setShowDownloadsTab(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.tasksTab.label")}
          description={t("settings.app.tasksTab.description")}
        >
          <Switch
            checked={appearance.showTasksTab}
            onChange={(event) =>
              appearance.setShowTasksTab(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.navLabels.label")}
          description={t("settings.app.navLabels.description")}
        >
          <Switch
            checked={appearance.showLabelsInNav}
            onChange={(event) =>
              appearance.setShowLabelsInNav(event.currentTarget.checked)
            }
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.app.reset.label")}
          description={t("settings.app.reset.description")}
        >
          <TextButton variant="default" onClick={appearance.resetAppearance}>
            {t("common.reset")}
          </TextButton>
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}

function DataSettingsSection({
  isBusy,
  onExport,
  onImport,
  onRunMaintenance,
}: {
  isBusy: boolean;
  onExport: () => void;
  onImport: () => void;
  onRunMaintenance: (
    kind: MainTaskKind,
    title: string,
    message: string,
    warning: string,
    action: () => Promise<{ rowsAffected: number }>,
    successMessage: (rowsAffected: number) => string,
  ) => void;
}) {
  const { t } = useTranslation();
  const userAgent = useUserAgentStore((state) => state.userAgent);
  const setUserAgent = useUserAgentStore((state) => state.setUserAgent);
  const resetUserAgent = useUserAgentStore((state) => state.resetUserAgent);
  const resetReadingProgressState = useReaderStore(
    (state) => state.resetReadingProgress,
  );
  const [userAgentInput, setUserAgentInput] = useState(userAgent);

  return (
    <Stack gap="md">
      <SettingsSection
        title={t("settings.data.backup.title")}
      >
        <SettingsFieldRow
          label={t("settings.data.backupFile.label")}
          description={t("settings.data.backupFile.description")}
        >
          <SettingsInlineControls>
            <TextButton onClick={onExport} loading={isBusy} disabled={isBusy}>
              {t("settings.data.exportBackup")}
            </TextButton>
            <TextButton
              onClick={onImport}
              loading={isBusy}
              disabled={isBusy}
              variant="default"
            >
              {t("settings.data.importBackup")}
            </TextButton>
          </SettingsInlineControls>
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.data.maintenance.title")}
      >
        <SettingsFieldRow
          label={t("settings.data.libraryMembership.label")}
          description={t("settings.data.libraryMembership.description")}
        >
          <TextButton
            disabled={isBusy}
            loading={isBusy}
            variant="default"
            onClick={() => {
              onRunMaintenance(
                "maintenance.clearLibraryMembership",
                t("settings.data.libraryMembership.button"),
                t("settings.data.libraryMembership.busy"),
                t("settings.data.libraryMembership.warning"),
                clearLibraryMembership,
                (rowsAffected) =>
                  t("settings.data.libraryMembership.done", {
                    count: rowsAffected,
                  }),
              );
            }}
          >
            {t("common.clear")}
          </TextButton>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.data.downloadedContent.label")}
          description={t("settings.data.downloadedContent.description")}
        >
          <TextButton
            disabled={isBusy}
            loading={isBusy}
            variant="default"
            onClick={() => {
              onRunMaintenance(
                "maintenance.clearDownloadedContent",
                t("settings.data.downloadedContent.button"),
                t("settings.data.downloadedContent.busy"),
                t("settings.data.downloadedContent.warning"),
                clearDownloadedChapterContentAndMedia,
                (rowsAffected) =>
                  t("settings.data.downloadedContent.done", {
                    count: rowsAffected,
                  }),
              );
            }}
          >
            {t("common.clear")}
          </TextButton>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.data.updatesQueue.label")}
          description={t("settings.data.updatesQueue.description")}
        >
          <TextButton
            disabled={isBusy}
            loading={isBusy}
            variant="default"
            onClick={() => {
              onRunMaintenance(
                "maintenance.clearUpdates",
                t("settings.data.updatesQueue.button"),
                t("settings.data.updatesQueue.busy"),
                t("settings.data.updatesQueue.warning"),
                clearUpdatesTab,
                (rowsAffected) =>
                  t("settings.data.updatesQueue.done", {
                    count: rowsAffected,
                  }),
              );
            }}
          >
            {t("common.clear")}
          </TextButton>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.data.readingProgress.label")}
          description={t("settings.data.readingProgress.description")}
        >
          <TextButton
            disabled={isBusy}
            loading={isBusy}
            variant="default"
            onClick={() => {
              onRunMaintenance(
                "maintenance.clearReadingProgress",
                t("settings.data.readingProgress.button"),
                t("settings.data.readingProgress.busy"),
                t("settings.data.readingProgress.warning"),
                async () => {
                  const result = await clearReadingProgress();
                  resetReadingProgressState();
                  return result;
                },
                (rowsAffected) =>
                  t("settings.data.readingProgress.done", {
                    count: rowsAffected,
                  }),
              );
            }}
          >
            {t("common.clear")}
          </TextButton>
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.data.network.title")}
      >
        <SettingsFieldRow
          label={t("settings.data.userAgent.label")}
          description={t("settings.data.userAgent.description")}
          layout="stacked"
        >
          <SettingsWideField>
            <Textarea
              value={userAgentInput}
              autosize
              minRows={3}
              onChange={(event) => setUserAgentInput(event.currentTarget.value)}
            />
          </SettingsWideField>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.data.saveUserAgent.label")}
          description={t("settings.data.saveUserAgent.description")}
        >
          <SettingsInlineControls>
            <TextButton
              onClick={() => {
                setUserAgent(userAgentInput);
                showSettingsToast("green", t("settings.toast.saved"));
              }}
            >
              {t("common.save")}
            </TextButton>
            <TextButton
              variant="default"
              onClick={() => {
                const userAgent = resetUserAgent();
                setUserAgentInput(userAgent);
                showSettingsToast("green", t("settings.toast.reset"));
              }}
            >
              {t("common.reset")}
            </TextButton>
          </SettingsInlineControls>
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}

function formatOptionalBuildTime(
  locale: AppLocale,
  buildTime: string | null | undefined,
): string {
  if (!buildTime) return "";
  const timestamp = Date.parse(buildTime);
  return Number.isFinite(timestamp)
    ? formatDateTimeForLocale(locale, timestamp)
    : buildTime;
}

function updateStatusLabel(
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  candidate: UpdateCandidate | null,
): string {
  if (!candidate) return "";
  switch (candidate.status) {
    case "newer":
      return t("settings.about.update.status.newer");
    case "current":
      return t("settings.about.update.status.current");
    case "unknown":
      return t("settings.about.update.status.unknown");
  }
}

function updateStatusMessage(
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  candidate: UpdateCandidate,
): string {
  switch (candidate.status) {
    case "newer":
      return t("settings.about.update.available", {
        name: candidate.displayName,
      });
    case "current":
      return t("settings.about.update.current", {
        name: candidate.displayName,
      });
    case "unknown":
      return t("settings.about.update.unknown", {
        name: candidate.displayName,
      });
  }
}

function canInstallUpdate(candidate: UpdateCandidate | null): boolean {
  return Boolean(candidate?.integrity && candidate.status !== "current");
}

function AboutSettingsSection({
  onOpenRelease,
}: {
  onOpenRelease: () => void;
}) {
  const { locale, t } = useTranslation();
  const logLevel = useLoggingStore((state) => state.logLevel);
  const setLogLevel = useLoggingStore((state) => state.setLogLevel);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [officialUpdate, setOfficialUpdate] =
    useState<UpdateCandidate | null>(null);
  const [devUpdate, setDevUpdate] = useState<UpdateCandidate | null>(null);
  const [updateBusy, setUpdateBusy] = useState<UpdateBusy | null>(null);

  useEffect(() => {
    let cancelled = false;

    getBuildInfo()
      .then((info) => {
        if (!cancelled) setBuildInfo(info);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          showSettingsToast(
            "red",
            t("settings.about.build.title"),
            t("settings.about.buildInfoFailed", {
              error: describeError(error),
            }),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  async function checkUpdate(channel: UpdateChannel): Promise<void> {
    if (!buildInfo) return;

    setUpdateBusy(`${channel}:check` as UpdateBusy);
    const toastId = `settings:update:${channel}:check`;
    const title = t(
      channel === "official"
        ? "settings.about.officialUpdate.label"
        : "settings.about.devUpdate.label",
    );
    showSettingsLoadingToast(
      toastId,
      title,
      t(
        channel === "official"
          ? "settings.about.update.checkingOfficial"
          : "settings.about.update.checkingDev",
      ),
    );
    try {
      const candidate =
        channel === "official"
          ? await checkOfficialUpdate(buildInfo)
          : await checkDevUpdate(buildInfo);
      if (channel === "official") {
        setOfficialUpdate(candidate);
      } else {
        setDevUpdate(candidate);
      }
      updateSettingsToast(
        toastId,
        "green",
        title,
        updateStatusMessage(t, candidate),
      );
    } catch (error) {
      updateSettingsToast(
        toastId,
        "red",
        title,
        t("settings.about.update.checkFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setUpdateBusy(null);
    }
  }

  async function openUpdate(candidate: UpdateCandidate): Promise<void> {
    if (!canInstallUpdate(candidate)) return;
    if (
      !window.confirm(
        t("settings.about.update.installConfirm", {
          name: candidate.assetName,
        }),
      )
    ) {
      return;
    }

    setUpdateBusy(`${candidate.channel}:install` as UpdateBusy);
    const toastId = `settings:update:${candidate.channel}:install`;
    const title = t("settings.about.update.install");
    showSettingsLoadingToast(
      toastId,
      title,
      t("settings.about.update.installing", {
        name: candidate.assetName,
      }),
    );
    try {
      const path = await installUpdate(candidate, buildInfo);
      updateSettingsToast(
        toastId,
        "green",
        title,
        t("settings.about.update.installerOpened", { path }),
      );
    } catch (error) {
      updateSettingsToast(
        toastId,
        "red",
        title,
        t("settings.about.update.installFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setUpdateBusy(null);
    }
  }

  const buildVersion = buildInfo?.buildVersion
    ? `v${buildInfo.buildVersion}`
    : "";
  const buildTime = formatOptionalBuildTime(locale, buildInfo?.buildTime);
  const platform = buildInfo?.platform ?? "";
  const buildChannel = buildInfo?.buildChannel ?? "";

  return (
    <Stack gap="md">
      <SettingsSection
        title={t("settings.about.build.title")}
      >
        <SettingsFieldRow
          label={t("settings.about.version.label")}
          description={t("settings.about.version.description")}
        >
          <ConsoleChip tone="accent">{buildVersion}</ConsoleChip>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.buildTime.label")}
          description={t("settings.about.buildTime.description")}
        >
          <ConsoleChip>{buildTime}</ConsoleChip>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.platform.label")}
          description={t("settings.about.platform.description")}
        >
          <ConsoleChip>{platform}</ConsoleChip>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.buildChannel.label")}
          description={t("settings.about.buildChannel.description")}
        >
          <ConsoleChip>{buildChannel}</ConsoleChip>
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.about.updates.title")}
      >
        <SettingsFieldRow
          label={t("settings.about.officialUpdate.label")}
          description={t("settings.about.officialUpdate.description")}
        >
          <SettingsInlineControls>
            {officialUpdate ? (
              <ConsoleChip>{updateStatusLabel(t, officialUpdate)}</ConsoleChip>
            ) : null}
            <TextButton
              loading={updateBusy === "official:check"}
              disabled={!buildInfo || updateBusy !== null}
              onClick={() => {
                void checkUpdate("official");
              }}
            >
              {t("settings.about.update.check")}
            </TextButton>
            <TextButton
              variant="default"
              loading={updateBusy === "official:install"}
              disabled={!canInstallUpdate(officialUpdate) || updateBusy !== null}
              onClick={() => {
                if (officialUpdate) void openUpdate(officialUpdate);
              }}
            >
              {t("settings.about.update.install")}
            </TextButton>
          </SettingsInlineControls>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.about.devUpdate.label")}
          description={t("settings.about.devUpdate.description")}
        >
          <SettingsInlineControls>
            {devUpdate ? (
              <ConsoleChip>{updateStatusLabel(t, devUpdate)}</ConsoleChip>
            ) : null}
            <TextButton
              loading={updateBusy === "dev:check"}
              disabled={!buildInfo || updateBusy !== null}
              onClick={() => {
                void checkUpdate("dev");
              }}
            >
              {t("settings.about.update.check")}
            </TextButton>
            <TextButton
              variant="default"
              loading={updateBusy === "dev:install"}
              disabled={!canInstallUpdate(devUpdate) || updateBusy !== null}
              onClick={() => {
                if (devUpdate) void openUpdate(devUpdate);
              }}
            >
              {t("settings.about.update.install")}
            </TextButton>
          </SettingsInlineControls>
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.about.diagnostics.title")}
      >
        <SettingsFieldRow
          label={t("settings.about.logLevel.label")}
          description={t("settings.about.logLevel.description")}
        >
          <Select
            allowDeselect={false}
            data={LOG_LEVELS.map((level) => ({
              value: level,
              label: t(LOG_LEVEL_LABEL_KEYS[level]),
            }))}
            value={logLevel}
            onChange={setLogLevel}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.about.links.title")}
      >
        <SettingsFieldRow
          label={t("settings.about.latestRelease.label")}
          description={t("settings.about.latestRelease.description")}
        >
          <SettingsInlineControls>
            <TextButton variant="default" onClick={onOpenRelease}>
              {t("settings.about.openLatestRelease")}
            </TextButton>
            <Anchor
              href={LATEST_RELEASE_URL}
              target="_blank"
              rel="noreferrer"
              size="sm"
            >
              {t("settings.about.githubReleases")}
            </Anchor>
          </SettingsInlineControls>
        </SettingsFieldRow>
      </SettingsSection>
    </Stack>
  );
}

function SettingsCategoryList({
  categories,
  activeId,
  onSelect,
}: {
  categories: readonly SettingsCategory[];
  activeId: SettingsCategoryId;
  onSelect: (id: SettingsCategoryId) => void;
}) {
  const { t } = useTranslation();

  return (
    <aside className="lnr-settings-nav" aria-label={t("settings.title")}>
      <div className="lnr-settings-nav-header">
        <Text className="lnr-console-kicker">{t("settings.title")}</Text>
      </div>
      <ScrollArea className="lnr-settings-nav-scroll">
        <div className="lnr-settings-nav-list">
          {categories.map((category) => {
            const selected = category.id === activeId;
            return (
              <UnstyledButton
                key={category.id}
                aria-current={selected ? "page" : undefined}
                className="lnr-settings-nav-item"
                data-active={selected}
                onClick={() => onSelect(category.id)}
                type="button"
              >
                <span className="lnr-settings-nav-label">
                  {category.title}
                </span>
              </UnstyledButton>
            );
          })}
        </div>
      </ScrollArea>
      <div className="lnr-settings-nav-footer">Tauri 2</div>
    </aside>
  );
}

function SettingsDetail({
  categories,
  category,
  onSelect,
}: {
  categories: readonly SettingsCategory[];
  category: SettingsCategory;
  onSelect: (id: SettingsCategoryId) => void;
}) {
  const { t } = useTranslation();

  return (
    <section
      className="lnr-settings-detail"
      aria-labelledby={`settings-${category.id}-title`}
    >
      <div className="lnr-settings-detail-inner">
        <Text className="lnr-settings-kicker">
          {t("settings.breadcrumb", { title: category.title })}
        </Text>
        <Group
          className="lnr-settings-detail-header"
          align="center"
          justify="flex-start"
          wrap="wrap"
        >
          <Box className="lnr-settings-detail-copy">
            <Title
              className="lnr-settings-detail-title"
              id={`settings-${category.id}-title`}
              order={1}
            >
              {category.title}
            </Title>
          </Box>
          <Select
            allowDeselect={false}
            aria-label={t("settings.sectionSelect.label")}
            className="lnr-settings-section-select"
            data={categories.map((item) => ({
              value: item.id,
              label: item.title,
            }))}
            value={category.id}
            onChange={(value) => {
              const nextCategory = categories.find((item) => item.id === value);
              if (nextCategory) onSelect(nextCategory.id);
            }}
          />
        </Group>

        <Stack className="lnr-settings-detail-body" gap="md">
          {category.content}
        </Stack>
      </div>
    </section>
  );
}

interface SettingsPageProps {
  section?: string;
}

export function SettingsPage({ section }: SettingsPageProps = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsCategoryId>(() =>
    normalizeSection(section),
  );
  const isBusy = busyAction !== null;

  useEffect(() => {
    setActiveSection(normalizeSection(section));
  }, [section]);

  async function handleExport(): Promise<void> {
    const toastId = "settings:backup:export";
    setBusyAction(toastId);
    showSettingsLoadingToast(
      toastId,
      t("settings.data.exportBackup"),
      t("settings.data.savingBackup"),
    );
    try {
      const path = await enqueueMainTask({
        kind: "backup.export",
        title: t("settings.data.exportBackup"),
        run: exportBackupToFile,
      }).promise;
      if (path) {
        updateSettingsToast(
          toastId,
          "green",
          t("settings.data.exportBackup"),
          t("settings.data.backupSaved", { path }),
        );
      } else {
        notifications.hide(toastId);
      }
    } catch (error) {
      updateSettingsToast(
        toastId,
        "red",
        t("settings.data.exportBackup"),
        t("settings.data.exportFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleImport(): Promise<void> {
    if (!window.confirm(t("settings.data.restoreWarning"))) {
      return;
    }
    const toastId = "settings:backup:restore";
    setBusyAction(toastId);
    showSettingsLoadingToast(
      toastId,
      t("settings.data.importBackup"),
      t("settings.data.restoringBackup"),
    );
    try {
      const path = await enqueueMainTask({
        kind: "backup.restore",
        title: t("settings.data.importBackup"),
        run: async () => {
          const path = await importBackupFromFile();
          if (path) {
            await pluginManager.reloadInstalledFromDb();
            await rehydrateImportedSettings();
            await refreshImportedDataQueries(queryClient);
          }
          return path;
        },
      }).promise;
      if (path) {
        updateSettingsToast(
          toastId,
          "green",
          t("settings.data.importBackup"),
          t("settings.data.restoredBackup", { path }),
        );
      } else {
        notifications.hide(toastId);
      }
    } catch (error) {
      updateSettingsToast(
        toastId,
        "red",
        t("settings.data.importBackup"),
        t("settings.data.restoreFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function runMaintenance(
    kind: MainTaskKind,
    title: string,
    message: string,
    warning: string,
    action: () => Promise<{ rowsAffected: number }>,
    successMessage: (rowsAffected: number) => string,
  ): Promise<void> {
    if (!window.confirm(warning)) {
      return;
    }
    setBusyAction(kind);
    showSettingsLoadingToast(kind, title, message);
    try {
      const result = await enqueueMainTask({
        kind,
        title,
        run: action,
      }).promise;
      if (kind === "maintenance.clearUpdates" && result.rowsAffected > 0) {
        markUpdatesIndexDirty("updates-cleared");
      }
      if (
        kind === "maintenance.clearLibraryMembership" &&
        result.rowsAffected > 0
      ) {
        markUpdatesIndexDirty("library-membership");
        void queryClient.invalidateQueries({ queryKey: ["category"] });
        void queryClient.invalidateQueries({ queryKey: ["novel"] });
      }
      if (
        kind === "maintenance.clearReadingProgress" &&
        result.rowsAffected > 0
      ) {
        markUpdatesIndexDirty("read-progress");
      }
      updateSettingsToast(
        kind,
        "green",
        title,
        successMessage(result.rowsAffected),
      );
    } catch (error) {
      updateSettingsToast(
        kind,
        "red",
        title,
        t("settings.data.maintenanceFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }

  function openLatestRelease(): void {
    void openUrl(LATEST_RELEASE_URL).catch((error: unknown) => {
      showSettingsToast(
        "red",
        t("settings.about.githubReleases"),
        t("settings.data.openReleaseFailed", {
          error: describeError(error),
        }),
      );
    });
  }

  const categories: SettingsCategory[] = [
    {
      id: "app",
      title: t("settings.category.app.title"),
      content: <AppSettingsSection isBusy={isBusy} />,
    },
    {
      id: "reader",
      title: t("settings.category.reader.title"),
      content: <ReaderSettingsPanel />,
    },
    {
      id: "library",
      title: t("settings.category.library.title"),
      content: <LibrarySettingsPanel />,
    },
    {
      id: "browse",
      title: t("settings.category.browse.title"),
      content: <BrowseSettingsPanel />,
    },
    {
      id: "data",
      title: t("settings.category.data.title"),
      content: (
        <DataSettingsSection
          isBusy={isBusy}
          onExport={() => {
            void handleExport();
          }}
          onImport={() => {
            void handleImport();
          }}
          onRunMaintenance={(
            kind,
            title,
            message,
            warning,
            action,
            successMessage,
          ) => {
            void runMaintenance(
              kind,
              title,
              message,
              warning,
              action,
              successMessage,
            );
          }}
        />
      ),
    },
    {
      id: "about",
      title: t("settings.category.about.title"),
      content: <AboutSettingsSection onOpenRelease={openLatestRelease} />,
    },
  ];

  const activeCategory =
    categories.find((category) => category.id === activeSection) ??
    categories[0];

  const selectCategory = (id: SettingsCategoryId) => {
    setActiveSection(id);
  };

  return (
    <PageFrame className="lnr-settings-page" size="full">
      <div className="lnr-settings-shell">
        <SettingsCategoryList
          activeId={activeCategory.id}
          categories={categories}
          onSelect={selectCategory}
        />
        <SettingsDetail
          categories={categories}
          category={activeCategory}
          onSelect={selectCategory}
        />
      </div>
    </PageFrame>
  );
}
