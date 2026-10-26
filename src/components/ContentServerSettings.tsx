import { useState } from "react";
import { Alert, NumberInput, Select, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { ContentServerError } from "../lib/content-sync/client";
import {
  syncContentServer,
} from "../lib/content-sync/sync";
import { useContentSyncStore } from "../store/content-sync";
import { SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";
import { ReadingStateSettings } from "./ReadingStateSettings";

export function ContentServerSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const serverUrl = useContentSyncStore((state) => state.serverUrl);
  const deviceName = useContentSyncStore((state) => state.deviceName);
  const defaultDeviceName = useQuery({
    queryKey: ["device", "default-name"],
    queryFn: () => invoke<string>("get_default_device_name"),
    staleTime: Infinity,
  });
  const syncMode = useContentSyncStore((state) => state.syncMode);
  const uploadConflictPolicy = useContentSyncStore((state) => state.uploadConflictPolicy);
  const syncIntervalMinutes = useContentSyncStore((state) => state.syncIntervalMinutes);
  const lookupTimeoutSeconds = useContentSyncStore((state) => state.lookupTimeoutSeconds);
  const status = useContentSyncStore((state) => state.status);
  const progress = useContentSyncStore((state) => state.progress);
  const error = useContentSyncStore((state) => state.error);
  const blocked = useContentSyncStore((state) => state.blocked);
  const setServerUrl = useContentSyncStore((state) => state.setServerUrl);
  const setDeviceName = useContentSyncStore((state) => state.setDeviceName);
  const setSyncMode = useContentSyncStore((state) => state.setSyncMode);
  const setUploadConflictPolicy = useContentSyncStore((state) => state.setUploadConflictPolicy);
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
    <>
    <SettingsSection title={t("contentSync.title")} description={t("contentSync.description")}>
      <SettingsFieldRow label={t("contentSync.serverUrl")}>
        <div className="norea-settings-connection">
          <TextInput
            aria-label={t("contentSync.serverUrl")}
            placeholder="http://127.0.0.1:8080"
            value={urlDraft}
            disabled={disabled}
            onChange={(event) => setUrlDraft(event.currentTarget.value)}
          />
          <TextButton tone="accent" disabled={disabled || urlDraft === serverUrl} onClick={() => {
            void run(async () => { setServerUrl(urlDraft.trim()); });
          }}>{t("common.save")}</TextButton>
        </div>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("contentSync.deviceName")}>
        <div className="norea-settings-connection">
          <TextInput aria-label={t("contentSync.deviceName")} value={deviceName || defaultDeviceName.data || ""}
            disabled={disabled} onChange={(event) => setDeviceName(event.currentTarget.value)} />
          <TextButton aria-label={t("contentSync.resetDeviceName")} disabled={disabled} onClick={() => {
            void run(async () => {
              await defaultDeviceName.refetch({ throwOnError: true });
              setDeviceName("");
            });
          }}>{t("common.reset")}</TextButton>
        </div>
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
      {syncMode === "periodic" ? (
        <SettingsFieldRow label={t("contentSync.interval")}>
          <NumberInput aria-label={t("contentSync.interval")} value={syncIntervalMinutes}
            min={1} max={1440} allowDecimal={false} allowNegative={false}
            onChange={(value) => { if (typeof value === "number") setSyncIntervalMinutes(value); }} />
        </SettingsFieldRow>
      ) : null}
      <SettingsFieldRow label={t("contentSync.lookupTimeout")} description={t("contentSync.lookupTimeoutDescription")}>
        <NumberInput aria-label={t("contentSync.lookupTimeout")} value={lookupTimeoutSeconds}
          min={1} max={120} allowDecimal={false} allowNegative={false}
          onChange={(value) => { if (typeof value === "number") setLookupTimeoutSeconds(value); }} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t("contentSync.manualSync")} description={t("contentSync.rescanDescription")}>
        <SettingsInlineControls>
          <TextButton tone="accent" loading={status === "syncing"} disabled={!serverUrl || busy} onClick={() => startSync()}>
            {t("contentSync.syncNow")}
          </TextButton>
          <TextButton disabled={disabled || status === "syncing" || !serverUrl} onClick={() => startSync(true)}>
            {t("contentSync.rescan")}
          </TextButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("contentSync.uploadConflictPolicy")} description={t("contentSync.uploadConflictDescription")}>
        <Select aria-label={t("contentSync.uploadConflictPolicy")} value={uploadConflictPolicy} allowDeselect={false}
          data={[
            { value: "prefer-complete", label: t("contentSync.preferComplete") },
            { value: "keep-server", label: t("contentSync.keepServer") },
            { value: "replace-server", label: t("contentSync.replaceServer") },
          ]}
          onChange={(value) => {
            if (value === "prefer-complete" || value === "keep-server" || value === "replace-server") setUploadConflictPolicy(value);
          }} />
      </SettingsFieldRow>
      {status === "syncing" || progress ? (
        <div className="norea-settings-feedback" role="status">
          {status === "syncing" ? <Text>{t("contentSync.background")}</Text> : null}
          {progress ? <Text>{t("contentSync.progress", progress)}</Text> : null}
        </div>
      ) : null}
      {actionError || error ? <Alert className="norea-settings-error" color="red" role="alert" style={{ whiteSpace: "pre-wrap" }}>{actionError || (blocked ? t("contentSync.blocked") : error)}</Alert> : null}
      <SettingsFieldRow label={t("contentSync.catalog")} description={t("contentSync.browseHint")}>
        <TextButton onClick={() => { void navigate({ to: "/browse", search: { q: "", tab: "server" } }); }}>
          {t("contentSync.browse")}
        </TextButton>
      </SettingsFieldRow>
    </SettingsSection>
    <ReadingStateSettings key={serverUrl} serverUrl={serverUrl} />
    </>
  );
}
