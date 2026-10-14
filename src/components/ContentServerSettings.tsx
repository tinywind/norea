import { useState } from "react";
import { Alert, Group, NumberInput, Select, Stack, Text, TextInput } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { ContentServerError } from "../lib/content-sync/client";
import {
  syncContentServer,
} from "../lib/content-sync/sync";
import { useContentSyncStore } from "../store/content-sync";
import { SettingsFieldRow, SettingsSection } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";

export function ContentServerSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const serverUrl = useContentSyncStore((state) => state.serverUrl);
  const deviceName = useContentSyncStore((state) => state.deviceName);
  const syncMode = useContentSyncStore((state) => state.syncMode);
  const syncIntervalMinutes = useContentSyncStore((state) => state.syncIntervalMinutes);
  const lookupTimeoutSeconds = useContentSyncStore((state) => state.lookupTimeoutSeconds);
  const status = useContentSyncStore((state) => state.status);
  const progress = useContentSyncStore((state) => state.progress);
  const error = useContentSyncStore((state) => state.error);
  const blocked = useContentSyncStore((state) => state.blocked);
  const setServerUrl = useContentSyncStore((state) => state.setServerUrl);
  const setDeviceName = useContentSyncStore((state) => state.setDeviceName);
  const setSyncMode = useContentSyncStore((state) => state.setSyncMode);
  const setSyncIntervalMinutes = useContentSyncStore((state) => state.setSyncIntervalMinutes);
  const setLookupTimeoutSeconds = useContentSyncStore((state) => state.setLookupTimeoutSeconds);
  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const disabled = busy;

  function startSync(rescan = false) {
    setActionError(null);
    void syncContentServer(true, rescan).catch(cause => setActionError(describeError(cause)));
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof ContentServerError && cause.status === 403 ? t("contentSync.blocked") : describeError(cause));
    } finally {
      setBusy(false);
    }
  }


  return (
    <SettingsSection title={t("contentSync.title")}>
      <Text size="sm" c="dimmed">{t("contentSync.description")}</Text>
      <SettingsFieldRow label={t("contentSync.serverUrl")} layout="stacked">
        <Stack gap="xs">
          <TextInput
            aria-label={t("contentSync.serverUrl")}
            placeholder="http://127.0.0.1:8080"
            value={urlDraft}
            disabled={disabled}
            onChange={(event) => setUrlDraft(event.currentTarget.value)}
          />
          <TextButton disabled={disabled || urlDraft === serverUrl} onClick={() => {
            void run(async () => { setServerUrl(urlDraft.trim()); });
          }}>{t("common.save")}</TextButton>
        </Stack>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("contentSync.deviceName")}>
        <TextInput aria-label={t("contentSync.deviceName")} value={deviceName}
          disabled={disabled} onChange={(event) => setDeviceName(event.currentTarget.value)} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t("contentSync.mode")} description={t("contentSync.modeDescription")}>
        <Select aria-label={t("contentSync.mode")} value={syncMode}
          data={[
            { value: "manual", label: t("contentSync.manual") },
            { value: "periodic", label: t("contentSync.periodic") },
            { value: "changes", label: t("contentSync.onChange") },
          ]}
          onChange={(value) => { if (value === "manual" || value === "periodic" || value === "changes") setSyncMode(value); }} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t("contentSync.lookupTimeout")} description={t("contentSync.lookupTimeoutDescription")}>
        <NumberInput aria-label={t("contentSync.lookupTimeout")} value={lookupTimeoutSeconds}
          min={1} max={120} allowDecimal={false} allowNegative={false}
          onChange={(value) => { if (typeof value === "number") setLookupTimeoutSeconds(value); }} />
      </SettingsFieldRow>
      {syncMode === "periodic" ? (
        <SettingsFieldRow label={t("contentSync.interval")}>
          <NumberInput aria-label={t("contentSync.interval")} value={syncIntervalMinutes}
            min={1} max={1440} allowDecimal={false} allowNegative={false}
            onChange={(value) => { if (typeof value === "number") setSyncIntervalMinutes(value); }} />
        </SettingsFieldRow>
      ) : null}
      <Group>
        <TextButton loading={status === "syncing"} disabled={!serverUrl || busy} onClick={() => startSync()}>
          {t("contentSync.syncNow")}
        </TextButton>
        <TextButton disabled={disabled || status === "syncing" || !serverUrl} onClick={() => startSync(true)}>
          {t("contentSync.rescan")}
        </TextButton>
      </Group>
      {status === "syncing" ? <Text size="sm" c="dimmed" role="status">{t("contentSync.background")}</Text> : null}
      {progress ? <Text size="sm" c="dimmed" role="status">{t("contentSync.progress", progress)}</Text> : null}
      <Text size="sm" c="dimmed">{t("contentSync.rescanDescription")}</Text>
      {actionError || error ? <Alert color="red" role="alert">{actionError || (blocked ? t("contentSync.blocked") : error)}</Alert> : null}
      <TextButton onClick={() => { void navigate({ to: "/browse", search: { q: "", tab: "server" } }); }}>{t("contentSync.browse")}</TextButton>
    </SettingsSection>
  );
}
