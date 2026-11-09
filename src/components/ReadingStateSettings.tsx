import { useEffect, useRef, useState } from "react";
import { Button, Paper, Stack, Switch, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { formatDateTimeForLocale, useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { ContentServerError } from "../lib/content-sync/client";
import { getUserStateStatus, resumeUserStateAfterRestore, synchronizeUserState } from "../lib/user-state/sync";
import { subscribeUserStateLedgerChanges } from "../db/user-state";
import { useContentSyncStore } from "../store/content-sync";
import { USER_STATE_IDLE_RUNTIME, useUserStateStore } from "../store/user-state";
import { SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { IconButton } from "./IconButton";
import { ConnectIcon, SyncIcon } from "./ui/icons";

const multilineButtonStyles = {
  root: { height: "auto", minHeight: 36, maxWidth: "100%", paddingBlock: 8 },
  label: { whiteSpace: "normal", overflow: "visible", textAlign: "center" },
} as const;

export function ReadingStateSettings({ serverUrl }: { serverUrl: string }) {
  const { locale, t } = useTranslation();
  const deviceName = useContentSyncStore(state => state.deviceName);
  const enabled = useUserStateStore(state => state.enabledByServer[serverUrl] === true);
  const runtime = useUserStateStore(state => state.runtimeByServer[serverUrl] ?? USER_STATE_IDLE_RUNTIME);
  const setEnabled = useUserStateStore(state => state.setEnabled);
  const defaultName = useQuery({
    queryKey: ["device", "default-name"], queryFn: () => invoke<string>("get_default_device_name"),
    staleTime: Infinity, meta: { errorPresentation: "inline" },
  });
  const status = useQuery({
    queryKey: ["user-state", "status", serverUrl], queryFn: getUserStateStatus,
    retry: false,
    meta: { errorPresentation: "inline" },
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const action = useRef(false);
  const working = busy || runtime.phase === "syncing";
  useEffect(() => { if (serverUrl) void status.refetch(); }, [serverUrl, runtime.revision, status.refetch]);
  useEffect(() => {
    if (!serverUrl) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void status.refetch(); }, 150);
    };
    const focus = () => { void status.refetch(); };
    const visible = () => { if (document.visibilityState === "visible") focus(); };
    const unsubscribe = subscribeUserStateLedgerChanges(schedule);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [serverUrl, status.refetch]);

  async function run(operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true;
    setBusy(true); setActionError(null);
    try {
      await operation();
    } catch (cause) {
      setActionError(cause instanceof ContentServerError && cause.status === 403 ? t("contentSync.blocked") : describeError(cause));
    } finally {
      action.current = false; setBusy(false);
      await status.refetch();
    }
  }

  const data = status.data;
  const pausedAfterRestore = data?.pausedAfterRestore === true;
  const error = actionError || runtime.error || (status.error ? describeError(status.error) : null);
  return (
    <SettingsSection title={t("userState.title")} description={t("userState.description")}>
      <SettingsFieldRow label={t("userState.workspace")} description={t("userState.workspaceScope")}
        status={!serverUrl ? t("userState.serverRequired") : data?.workspaceId ? t("userState.connected") : t("userState.notConnected")}>
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{serverUrl}</Text>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("userState.thisDevice")}>
        <Text size="sm">{deviceName || defaultName.data || t("common.loading")}</Text>
      </SettingsFieldRow>
      {pausedAfterRestore ? (
        <Paper withBorder p="md" role="status">
          <Stack gap="sm">
            <Text fw="var(--norea-weight-bold)">{t("userState.restorePaused")}</Text>
            <Text size="sm">{t("userState.restorePausedDescription")}</Text>
            <Text size="sm">{t("userState.restoreMergeDescription")}</Text>
            <Text size="sm">{t("userState.restoreOverwriteDescription")}</Text>
            <Text size="sm">{t("userState.restoreSnapshotDescription")}</Text>
            <Button styles={multilineButtonStyles} leftSection={<ConnectIcon />} variant="default" loading={working} disabled={!serverUrl || working}
              onClick={() => { void run(resumeUserStateAfterRestore); }}>
              {t("userState.reconnectAfterRestore")}
            </Button>
          </Stack>
        </Paper>
      ) : null}
      <SettingsFieldRow label={t("userState.automatic")} description={t("userState.automaticDescription")}>
        <Switch checked={enabled} disabled={!serverUrl || pausedAfterRestore} aria-label={t("userState.automatic")}
          onChange={event => setEnabled(serverUrl, event.currentTarget.checked)} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t("userState.syncNow")} description={t(pausedAfterRestore ? "userState.restorePaused" : "userState.offDescription")} error={error}
        status={pausedAfterRestore ? t("userState.restorePaused") : working ? t("userState.syncing") : data?.lastSuccessAt ? t("userState.lastSuccess", {
          time: formatDateTimeForLocale(locale, data.lastSuccessAt),
        }) : t("userState.never")}>
        <SettingsInlineControls>
          <IconButton label={t("userState.syncNow")} size="lg" loading={working} disabled={!serverUrl || working || pausedAfterRestore}
            onClick={() => { void run(synchronizeUserState); }}><SyncIcon /></IconButton>
        </SettingsInlineControls>
      </SettingsFieldRow>

    </SettingsSection>
  );
}
