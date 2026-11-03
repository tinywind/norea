import { Select, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ContentServerSettings } from "../ContentServerSettings";
import {
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
} from "../SettingsPrimitives";
import { TextButton } from "../TextButton";
import { useConfirm } from "../ui/ConfirmDialog";
import { exportBackupToFile, importBackupFromFile } from "../../lib/backup/io";
import { describeError } from "../../lib/errors";
import { pluginManager } from "../../lib/plugins/manager";
import { enqueueMainTask } from "../../lib/tasks/main-tasks";
import { formatDateTimeForLocale, useTranslation } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import {
  AUTO_BACKUP_KEEP_OPTIONS,
  DEFAULT_AUTO_BACKUP_KEEP,
  normalizeAutoBackupSchedule,
  useAutoBackupStore,
  type AutoBackupSchedule,
} from "../../store/auto-backup";
import { useBrowseStore } from "../../store/browse";
import { useLibraryStore } from "../../store/library";
import { useNotificationStore } from "../../store/notifications";
import { useReaderStore } from "../../store/reader";
import { useUserAgentStore } from "../../store/user-agent";
import { reconcileChapterStorage } from "./DownloadsSection";
import type { SettingsBusyProps } from "./settings-busy";
import { showSettingsLoadingToast, updateSettingsToast } from "./settings-toast";

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

const SCHEDULE_LABEL_KEYS = {
  off: "settings.backup.auto.off",
  daily: "settings.backup.auto.daily",
  weekly: "settings.backup.auto.weekly",
} as const satisfies Record<AutoBackupSchedule, string>;

function AutomaticBackupSettings() {
  const { locale, t } = useTranslation();
  const confirm = useConfirm();
  const autoBackup = useAutoBackupStore();

  const changeSchedule = async (value: string | null) => {
    const schedule = normalizeAutoBackupSchedule(value);
    if (autoBackup.schedule === "off" && schedule !== "off") {
      const confirmed = await confirm({
        title: t("settings.backup.auto.enableTitle"),
        message: t("settings.backup.auto.coverage"),
        confirmLabel: t("settings.backup.auto.enable"),
      });
      if (!confirmed) return;
    }
    autoBackup.setSchedule(schedule);
  };

  const status = autoBackup.lastSuccessAt === null
    ? t("settings.backup.auto.never")
    : t("settings.backup.auto.last", {
        time: formatDateTimeForLocale(locale, new Date(autoBackup.lastSuccessAt)),
      });

  return (
    <SettingsSection title={t("settings.backup.auto.title")}>
      <SettingsFieldRow
        label={t("settings.backup.auto.schedule.label")}
        description={t("settings.backup.auto.schedule.description")}
        status={autoBackup.schedule === "off" ? null : status}
        error={autoBackup.lastError === null
          ? null
          : t("settings.backup.auto.failed", { error: autoBackup.lastError })}
      >
        <Select
          allowDeselect={false}
          data={(["off", "daily", "weekly"] as const).map((value) => ({
            value,
            label: t(SCHEDULE_LABEL_KEYS[value]),
          }))}
          value={autoBackup.schedule}
          onChange={(value) => void changeSchedule(value)}
        />
      </SettingsFieldRow>
      {autoBackup.schedule === "off" ? null : (
        <SettingsFieldRow
          label={t("settings.backup.auto.keep.label")}
          description={t("settings.backup.auto.keep.description")}
        >
          <Select
            allowDeselect={false}
            data={[...new Set([...AUTO_BACKUP_KEEP_OPTIONS, autoBackup.keep])]
              .sort((a, b) => a - b)
              .map((count) => ({ value: String(count), label: String(count) }))}
            value={String(autoBackup.keep)}
            onChange={(value) => autoBackup.setKeep(Number(value ?? DEFAULT_AUTO_BACKUP_KEEP))}
          />
        </SettingsFieldRow>
      )}
    </SettingsSection>
  );
}

export function BackupSection({ isBusy, onBusyChange }: SettingsBusyProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  async function handleExport(): Promise<void> {
    const toastId = "settings:backup:export";
    onBusyChange(toastId);
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
          "ok",
          t("settings.data.exportBackup"),
          t("settings.data.backupSaved", { path }),
        );
      } else {
        notifications.hide(toastId);
      }
    } catch (error) {
      updateSettingsToast(
        toastId,
        "danger",
        t("settings.data.exportBackup"),
        t("settings.data.exportFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      onBusyChange(null);
    }
  }

  async function handleImport(): Promise<void> {
    const confirmed = await confirm({
      title: t("settings.data.importBackup"),
      message: t("settings.data.restoreWarning"),
      confirmLabel: t("settings.data.importBackup"),
      danger: true,
    });
    if (!confirmed) return;
    const toastId = "settings:backup:restore";
    onBusyChange(toastId);
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
            reconcileChapterStorage(queryClient);
          }
          return path;
        },
      }).promise;
      if (path) {
        updateSettingsToast(
          toastId,
          "ok",
          t("settings.data.importBackup"),
          t("settings.data.restoredBackup", { path }),
        );
      } else {
        notifications.hide(toastId);
      }
    } catch (error) {
      updateSettingsToast(
        toastId,
        "danger",
        t("settings.data.importBackup"),
        t("settings.data.restoreFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      onBusyChange(null);
    }
  }

  return (
    <Stack gap="md">
      <SettingsSection title={t("settings.data.backup.title")}>
        <SettingsFieldRow
          label={t("settings.data.backupFile.label")}
          description={t("settings.data.backupFile.description")}
        >
          <SettingsInlineControls>
            <TextButton
              tone="accent"
              onClick={() => {
                void handleExport();
              }}
              loading={isBusy}
              disabled={isBusy}
            >
              {t("settings.data.exportBackup")}
            </TextButton>
            <TextButton
              onClick={() => {
                void handleImport();
              }}
              loading={isBusy}
              disabled={isBusy}
              variant="default"
            >
              {t("settings.data.importBackup")}
            </TextButton>
          </SettingsInlineControls>
        </SettingsFieldRow>
      </SettingsSection>

      <AutomaticBackupSettings />

      <ContentServerSettings />
    </Stack>
  );
}
