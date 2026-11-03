import { useState } from "react";
import { Checkbox, Stack } from "@mantine/core";
import {
  SettingsFieldRow,
  SettingsInlineControls,
  SettingsSection,
} from "../SettingsPrimitives";
import { TextButton } from "../TextButton";
import { useConfirm } from "../ui/ConfirmDialog";
import {
  clearReadingProgress,
  clearUpdatesTab,
} from "../../db/queries/maintenance";
import { listLibraryNovels } from "../../db/queries/novel";
import { describeError } from "../../lib/errors";
import { enqueueMainTask } from "../../lib/tasks/main-tasks";
import type { MainTaskKind } from "../../lib/tasks/scheduler";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { useTranslation } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { confirmContentDeletion } from "../../store/content-deletion";
import { useReaderStore } from "../../store/reader";
import type { SettingsBusyProps } from "./settings-busy";
import {
  showSettingsLoadingToast,
  showSettingsToast,
  updateSettingsToast,
} from "./settings-toast";

/** Global destructive actions. Contextual ones stay with their own settings. */
export function ResetSection({ isBusy, onBusyChange }: SettingsBusyProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const resetAppearance = useAppearanceStore((state) => state.resetAppearance);
  const resetReaderSettings = useReaderStore(
    (state) => state.resetReaderSettings,
  );
  const resetReadingProgressState = useReaderStore(
    (state) => state.resetReadingProgress,
  );
  const [keepScopedReaderSettings, setKeepScopedReaderSettings] =
    useState(true);

  async function runMaintenance(
    kind: MainTaskKind,
    title: string,
    message: string,
    warning: string,
    action: () => Promise<{ rowsAffected: number }>,
    successMessage: (rowsAffected: number) => string,
  ): Promise<void> {
    const confirmed = await confirm({
      title,
      message: warning,
      confirmLabel: title,
      danger: true,
    });
    if (!confirmed) return;
    onBusyChange(kind);
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
        kind === "maintenance.clearReadingProgress" &&
        result.rowsAffected > 0
      ) {
        markUpdatesIndexDirty("read-progress");
      }
      updateSettingsToast(
        kind,
        "ok",
        title,
        successMessage(result.rowsAffected),
      );
    } catch (error) {
      updateSettingsToast(
        kind,
        "danger",
        title,
        t("settings.data.maintenanceFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      onBusyChange(null);
    }
  }

  async function clearLibrary(): Promise<void> {
    const kind = "maintenance.clearLibraryMembership";
    const title = t("settings.data.libraryMembership.button");
    onBusyChange(kind);
    try {
      const novels = await listLibraryNovels();
      await confirmContentDeletion({
        kind: "library",
        ids: novels.map((novel) => novel.id),
        title,
      });
    } catch (error) {
      showSettingsToast(
        "danger",
        title,
        t("settings.data.maintenanceFailed", {
          error: describeError(error),
        }),
      );
    } finally {
      onBusyChange(null);
    }
  }

  async function confirmResetAppearance(): Promise<void> {
    const confirmed = await confirm({
      title: t("settings.app.reset.label"),
      message: t("settings.reset.appearance.warning"),
      confirmLabel: t("common.reset"),
      danger: true,
    });
    if (!confirmed) return;
    resetAppearance();
    showSettingsToast("ok", t("settings.toast.reset"));
  }

  async function confirmResetReader(): Promise<void> {
    const confirmed = await confirm({
      title: t("readerSettings.reset.title"),
      message: keepScopedReaderSettings
        ? t("readerSettings.reset.globalMessage")
        : t("settings.reset.reader.allWarning"),
      confirmLabel: t("common.reset"),
      danger: true,
    });
    if (!confirmed) return;
    resetReaderSettings({ keepScopedSettings: keepScopedReaderSettings });
    showSettingsToast("ok", t("settings.toast.reset"));
  }

  return (
    <Stack gap="md">
      <SettingsSection title={t("settings.data.maintenance.title")}>
        <SettingsFieldRow
          label={t("settings.data.libraryMembership.label")}
          description={t("settings.data.libraryMembership.description")}
        >
          <TextButton
            disabled={isBusy}
            loading={isBusy}
            variant="default"
            tone="danger"
            onClick={() => {
              void clearLibrary();
            }}
          >
            {t("settings.data.libraryMembership.button")}
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
            tone="danger"
            onClick={() => {
              void runMaintenance(
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
            {t("settings.data.readingProgress.button")}
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
              void runMaintenance(
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
            {t("settings.data.updatesQueue.button")}
          </TextButton>
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t("settings.reset.settings.title")}>
        <SettingsFieldRow
          label={t("settings.app.reset.label")}
          description={t("settings.app.reset.description")}
        >
          <TextButton
            variant="default"
            tone="danger"
            onClick={() => {
              void confirmResetAppearance();
            }}
          >
            {t("common.reset")}
          </TextButton>
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t("settings.reset.reader.label")}
          description={t("settings.reset.reader.description")}
        >
          <SettingsInlineControls>
            <Checkbox
              checked={keepScopedReaderSettings}
              label={t("readerSettings.reset.keepScopedSettings")}
              onChange={(event) =>
                setKeepScopedReaderSettings(event.currentTarget.checked)
              }
            />
            <TextButton
              variant="default"
              tone="danger"
              onClick={() => {
                void confirmResetReader();
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
