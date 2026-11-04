import { useRef, useState } from "react";
import { Select, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { formatDateTimeForLocale, useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { ContentServerError } from "../lib/content-sync/client";
import {
  defaultBackupDeviceName, DeviceBackupError, listDeviceBackups, restoreDeviceBackup, uploadDeviceBackup,
  type DeviceBackupPhase,
} from "../lib/content-sync/device-backup";
import { useContentSyncStore } from "../store/content-sync";
import { SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";
import { useConfirm } from "./ui/ConfirmDialog";

export function ReadingStateSettings({ serverUrl }: { serverUrl: string }) {
  const { locale, t } = useTranslation();
  const deviceName = useContentSyncStore(state => state.deviceName);
  const ownName = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["device-backup", "name", deviceName],
    queryFn: defaultBackupDeviceName, staleTime: Infinity,
  });
  const backups = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["device-backup", "list", serverUrl],
    queryFn: ({ signal }) => listDeviceBackups(serverUrl, signal),
    enabled: Boolean(serverUrl), staleTime: 60_000, retry: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<DeviceBackupPhase | null>(null);
  const [mode, setMode] = useState<"upload" | "restore" | null>(null);
  const [error, setError] = useState<{ mode: "upload" | "restore"; message: string } | null>(null);
  const action = useRef(false);
  const confirm = useConfirm();
  const busy = mode !== null;
  const entry = backups.data?.find(item => item.deviceName === selected);

  function message(cause: unknown): string {
    return cause instanceof DeviceBackupError ? t(`deviceBackup.${cause.code}`)
      : cause instanceof ContentServerError && cause.status === 403 ? t("contentSync.blocked") : describeError(cause);
  }
  async function run(nextMode: "upload" | "restore") {
    if (action.current || (nextMode === "restore" && !entry)) return;
    action.current = true;
    setMode(nextMode); setError(null);
    try {
      if (nextMode === "upload") {
        const saved = await uploadDeviceBackup(serverUrl, setPhase);
        notifications.show({ color: "ok", title: t("deviceBackup.title"), message: t("deviceBackup.saved", { name: saved.deviceName }) });
        await backups.refetch();
      } else {
        await restoreDeviceBackup(serverUrl, entry!, setPhase);
      }
    } catch (cause) {
      setError({ mode: nextMode, message: message(cause) });
    } finally {
      action.current = false; setMode(null); setPhase(null);
    }
  }
  async function confirmAndRestore() {
    if (!entry) return;
    const confirmed = await confirm({
      title: t("deviceBackup.restore"),
      message: t("deviceBackup.restoreWarning", { name: entry.deviceName }),
      confirmLabel: t("deviceBackup.confirmRestore"),
      danger: true,
    });
    if (confirmed) await run("restore");
  }

  return (
    <SettingsSection title={t("deviceBackup.title")} description={t("deviceBackup.description")}>
      <SettingsFieldRow label={t("deviceBackup.thisDevice")} description={t("deviceBackup.thisDeviceDescription")}
        status={mode === "upload" && phase ? t(`deviceBackup.${phase}`) : null}
        error={error?.mode === "upload" ? error.message : ownName.error ? message(ownName.error) : null}>
        <SettingsInlineControls>
          <Text>{ownName.data || t("common.loading")}</Text>
          <TextButton variant="filled" loading={mode === "upload"} disabled={busy || !serverUrl || !ownName.data}
            onClick={() => { void run("upload"); }}>{t("deviceBackup.upload")}</TextButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("deviceBackup.savedDevices")} description={t("deviceBackup.restoreDescription")}
        status={!serverUrl ? t("deviceBackup.serverRequired") : backups.data?.length === 0 ? t("deviceBackup.empty") : null}
        error={backups.error ? message(backups.error) : null}>
        <div className="norea-settings-connection">
          <Select aria-label={t("deviceBackup.savedDevices")} placeholder={t("deviceBackup.chooseDevice")}
            value={selected} onChange={setSelected} searchable clearable disabled={busy || !serverUrl}
            data={(backups.data ?? []).map(item => ({ value: item.deviceName, label: item.deviceName }))}
            nothingFoundMessage={t("deviceBackup.empty")} />
          <TextButton loading={backups.isFetching} disabled={busy || !serverUrl} onClick={() => { void backups.refetch(); }}>
            {t("common.refresh")}
          </TextButton>
        </div>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("deviceBackup.restore")}
        status={mode === "restore" && phase ? t(`deviceBackup.${phase}`) : null}
        error={error?.mode === "restore" ? error.message : null}>
        <SettingsInlineControls>
          <TextButton tone="danger" loading={mode === "restore"} disabled={busy || !serverUrl || !entry}
            onClick={() => { void confirmAndRestore(); }}>{t("deviceBackup.restore")}</TextButton>
          {entry ? <Text size="sm">{t("deviceBackup.details", {
            date: formatDateTimeForLocale(locale, entry.updatedAt), size: (entry.size / 1024 / 1024).toFixed(2),
          })}</Text> : null}
        </SettingsInlineControls>
      </SettingsFieldRow>
    </SettingsSection>
  );
}
