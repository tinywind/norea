import { useState, useSyncExternalStore } from "react";
import { Button, Group, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import { runAutomaticBackupIfDue } from "../lib/backup/auto-backup";
import { showErrorToast } from "../lib/runtime/error-toast";
import { useAutoBackupStore } from "../store/auto-backup";
import { chooseStorageFolder } from "./settings/DownloadsSection";

/** Whether automatic backup is on and its last attempt could not reach the storage folder. */
export function useBackupFolderUnavailable(): boolean {
  return useSyncExternalStore(useAutoBackupStore.subscribe, backupFolderUnavailable, backupFolderUnavailable);
}

function backupFolderUnavailable(): boolean {
  const { lastFailureFolderUnavailable, schedule } = useAutoBackupStore.getState();
  return schedule !== "off" && lastFailureFolderUnavailable;
}

/** One Needs attention line while automatic backups cannot reach the storage folder. */
export function BackupFolderAttention() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const unavailable = useBackupFolderUnavailable();
  const [busy, setBusy] = useState(false);
  if (!unavailable) return null;

  const chooseFolder = async () => {
    setBusy(true);
    try {
      const root = await chooseStorageFolder(queryClient);
      if (!root) return;
      useAutoBackupStore.getState().clearFailure();
      void runAutomaticBackupIfDue();
    } catch (error) {
      showErrorToast(t("settings.backup.auto.folderUnavailable"), error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="norea-source-access-banner" data-backup-folder-unavailable="true" role="status">
      <div className="norea-source-access-copy">
        <Text component="h3" fw={700} size="sm">{t("settings.backup.auto.folderUnavailable")}</Text>
      </div>
      <Group gap="xs" justify="flex-end">
        <Button loading={busy} onClick={() => void chooseFolder()} size="xs" variant="light">
          {t("settings.backup.auto.chooseFolder")}
        </Button>
      </Group>
    </section>
  );
}
