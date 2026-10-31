import { useRef, useState } from "react";
import { Alert, Modal, Select, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { ContentServerError } from "../lib/content-sync/client";
import {
  defaultBackupDeviceName, DeviceBackupError, listDeviceBackups, restoreDeviceBackup, uploadDeviceBackup,
  type DeviceBackupPhase,
} from "../lib/content-sync/device-backup";
import { useContentSyncStore } from "../store/content-sync";
import { SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";

export function ReadingStateSettings({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation();
  const deviceName = useContentSyncStore(state => state.deviceName);
  const ownName = useQuery({
    queryKey: ["device-backup", "name", deviceName],
    queryFn: defaultBackupDeviceName, staleTime: Infinity,
  });
  const backups = useQuery({
    queryKey: ["device-backup", "list", serverUrl],
    queryFn: ({ signal }) => listDeviceBackups(serverUrl, signal),
    enabled: Boolean(serverUrl), staleTime: 60_000, retry: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<DeviceBackupPhase | null>(null);
  const [mode, setMode] = useState<"upload" | "restore" | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useRef(false);
  const busy = mode !== null;
  const entry = backups.data?.find(item => item.deviceName === selected);

  function message(cause: unknown): string {
    return cause instanceof DeviceBackupError ? t(`deviceBackup.${cause.code}`)
      : cause instanceof ContentServerError && cause.status === 403 ? t("contentSync.blocked") : describeError(cause);
  }
  async function run(nextMode: "upload" | "restore") {
    if (action.current || (nextMode === "restore" && !entry)) return;
    action.current = true;
    setMode(nextMode); setError(null); setNotice(null); setConfirmRestore(false);
    try {
      if (nextMode === "upload") {
        const saved = await uploadDeviceBackup(serverUrl, setPhase);
        setNotice(t("deviceBackup.saved", { name: saved.deviceName }));
        await backups.refetch();
      } else {
        await restoreDeviceBackup(serverUrl, entry!, setPhase);
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      action.current = false; setMode(null); setPhase(null);
    }
  }

  return (
    <SettingsSection title={t("deviceBackup.title")} description={t("deviceBackup.description")}>
      <SettingsFieldRow label={t("deviceBackup.thisDevice")} description={t("deviceBackup.thisDeviceDescription")}>
        <SettingsInlineControls>
          <Text>{ownName.data || t("common.loading")}</Text>
          <TextButton tone="accent" loading={mode === "upload"} disabled={busy || !serverUrl || !ownName.data}
            onClick={() => { void run("upload"); }}>{t("deviceBackup.upload")}</TextButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("deviceBackup.savedDevices")} description={t("deviceBackup.restoreDescription")}>
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
      <SettingsFieldRow label={t("deviceBackup.restore")}>
        <SettingsInlineControls>
          <TextButton tone="danger" loading={mode === "restore"} disabled={busy || !serverUrl || !entry}
            onClick={() => setConfirmRestore(true)}>{t("deviceBackup.restore")}</TextButton>
          {entry ? <Text size="sm">{t("deviceBackup.details", {
            date: new Date(entry.updatedAt).toLocaleString(), size: (entry.size / 1024 / 1024).toFixed(2),
          })}</Text> : null}
        </SettingsInlineControls>
      </SettingsFieldRow>
      {!serverUrl ? <Text className="norea-settings-feedback">{t("deviceBackup.serverRequired")}</Text> : null}
      {serverUrl && backups.data?.length === 0 ? <Text className="norea-settings-feedback">{t("deviceBackup.empty")}</Text> : null}
      {phase ? <Text className="norea-settings-feedback" role="status">{t(`deviceBackup.${phase}`)}</Text> : null}
      {notice ? <Alert className="norea-settings-feedback" color="green" role="status">{notice}</Alert> : null}
      {error || backups.error || ownName.error ? <Alert className="norea-settings-error" color="red" role="alert">
        {error || message(backups.error || ownName.error)}
      </Alert> : null}
      <Modal opened={confirmRestore} onClose={() => setConfirmRestore(false)} title={t("deviceBackup.restore")} centered>
        <Text>{t("deviceBackup.restoreWarning", { name: entry?.deviceName ?? "" })}</Text>
        <SettingsInlineControls>
          <TextButton onClick={() => setConfirmRestore(false)}>{t("common.cancel")}</TextButton>
          <TextButton tone="danger" disabled={!entry || busy} onClick={() => { void run("restore"); }}>
            {t("deviceBackup.confirmRestore")}
          </TextButton>
        </SettingsInlineControls>
      </Modal>
    </SettingsSection>
  );
}
