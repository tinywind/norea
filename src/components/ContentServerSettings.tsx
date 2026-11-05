import { useState } from "react";
import { NumberInput, Popover, Select, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError, userFacingErrorKey } from "../lib/errors";
import { ContentServerError } from "../lib/content-sync/client";
import {
  syncContentServer,
} from "../lib/content-sync/sync";
import { useContentSyncStore } from "../store/content-sync";
import { SettingsAdvancedGroup, SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { IconButton } from "./IconButton";
import { BrowseIcon, RescanIcon, ResetIcon, SaveIcon, SyncIcon } from "./ui/icons";
import { ReadingStateSettings } from "./ReadingStateSettings";
import { showSettingsToast } from "./settings/settings-toast";

function contentSyncErrorKey(error: string): TranslationKey {
  const key = userFacingErrorKey(error);
  if (key === "errors.network") return "contentSync.error.network";
  if (key === "errors.timeout") return "contentSync.error.timeout";
  return "contentSync.error.generic";
}

/** A sync failure as one plain sentence; the raw error stays one tap away for reports. */
function ContentSyncErrorLine({ error }: { error: string }) {
  const { t } = useTranslation();
  return (
    <>
      {t(contentSyncErrorKey(error))}
      <Popover position="bottom-start" shadow="md">
        <Popover.Target>
          <button className="norea-settings-form-error-details" type="button">{t("common.details")}</button>
        </Popover.Target>
        <Popover.Dropdown>
          <Text className="norea-settings-form-error-raw" size="sm">{error}</Text>
        </Popover.Dropdown>
      </Popover>
    </>
  );
}

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
  const [deviceNameDraft, setDeviceNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const disabled = busy;
  const blockedMessage = t("contentSync.blocked");
  const syncError = actionError || (blocked ? blockedMessage : error);
  const syncStatus = [
    status === "syncing" ? t("contentSync.background") : null,
    progress ? t("contentSync.progress", progress) : null,
  ].filter(Boolean).join(" · ") || null;

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
            placeholder={t("contentSync.serverUrlPlaceholder")}
            value={urlDraft}
            disabled={disabled}
            onChange={(event) => setUrlDraft(event.currentTarget.value)}
          />
          <IconButton label={t("contentSync.saveServerUrl")} size="lg" disabled={disabled || urlDraft === serverUrl} onClick={() => {
            void run(async () => {
              setServerUrl(urlDraft.trim());
              showSettingsToast("ok", t("settings.toast.saved"));
            });
          }}><SaveIcon /></IconButton>
        </div>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("contentSync.deviceName")}>
        <div className="norea-settings-connection">
          <TextInput aria-label={t("contentSync.deviceName")} value={deviceNameDraft ?? (deviceName || defaultDeviceName.data || "")}
            disabled={disabled} onChange={(event) => setDeviceNameDraft(event.currentTarget.value)}
            onBlur={() => {
              if (deviceNameDraft === null) return;
              setDeviceName(deviceNameDraft.trim());
              setDeviceNameDraft(null);
            }} />
          <IconButton label={t("contentSync.resetDeviceName")} size="lg" disabled={disabled} onClick={() => {
            void run(async () => {
              await defaultDeviceName.refetch({ throwOnError: true });
              setDeviceNameDraft(null);
              setDeviceName("");
            });
          }}><ResetIcon /></IconButton>
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
          <NumberInput aria-label={t("contentSync.interval")} className="norea-settings-compact-field" value={syncIntervalMinutes}
            min={1} max={1440} allowDecimal={false} allowNegative={false}
            onChange={(value) => { if (typeof value === "number") setSyncIntervalMinutes(value); }} />
        </SettingsFieldRow>
      ) : null}
      <SettingsFieldRow label={t("contentSync.manualSync")} description={t("contentSync.rescanDescription")}
        status={syncStatus} error={syncError && syncError !== blockedMessage ? <ContentSyncErrorLine error={syncError} /> : syncError}>
        <SettingsInlineControls>
          <IconButton label={t("contentSync.syncNow")} size="lg" loading={status === "syncing"} disabled={!serverUrl || busy}
            onClick={() => startSync()}>
            <SyncIcon />
          </IconButton>
          <IconButton label={t("contentSync.rescan")} size="lg" disabled={disabled || status === "syncing" || !serverUrl}
            onClick={() => startSync(true)}>
            <RescanIcon />
          </IconButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("contentSync.catalog")} description={t("contentSync.browseHint")}>
        <IconButton label={t("contentSync.browse")} size="lg"
          onClick={() => { void navigate({ to: "/browse", search: { q: "", tab: "server" } }); }}>
          <BrowseIcon />
        </IconButton>
      </SettingsFieldRow>
      <SettingsAdvancedGroup>
        <SettingsFieldRow label={t("contentSync.lookupTimeout")} description={t("contentSync.lookupTimeoutDescription")}>
          <NumberInput aria-label={t("contentSync.lookupTimeout")} className="norea-settings-compact-field" value={lookupTimeoutSeconds}
            min={1} max={120} allowDecimal={false} allowNegative={false}
            onChange={(value) => { if (typeof value === "number") setLookupTimeoutSeconds(value); }} />
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
      </SettingsAdvancedGroup>
    </SettingsSection>
    <ReadingStateSettings key={serverUrl} serverUrl={serverUrl} />
    </>
  );
}
