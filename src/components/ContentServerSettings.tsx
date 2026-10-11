import { useState } from "react";
import { Alert, Group, NumberInput, Select, Stack, Text, TextInput } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { ContentServerError } from "../lib/content-sync/client";
import {
  deleteServerChapter,
  downloadServerChapter,
  restoreServerChapter,
  syncContentServer,
} from "../lib/content-sync/sync";
import { useContentSyncStore } from "../store/content-sync";
import { SettingsFieldRow, SettingsSection } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";

export function ContentServerSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const serverUrl = useContentSyncStore((state) => state.serverUrl);
  const deviceName = useContentSyncStore((state) => state.deviceName);
  const syncMode = useContentSyncStore((state) => state.syncMode);
  const syncIntervalMinutes = useContentSyncStore((state) => state.syncIntervalMinutes);
  const status = useContentSyncStore((state) => state.status);
  const error = useContentSyncStore((state) => state.error);
  const blocked = useContentSyncStore((state) => state.blocked);
  const catalog = useContentSyncStore((state) => state.catalog);
  const setServerUrl = useContentSyncStore((state) => state.setServerUrl);
  const setDeviceName = useContentSyncStore((state) => state.setDeviceName);
  const setSyncMode = useContentSyncStore((state) => state.setSyncMode);
  const setSyncIntervalMinutes = useContentSyncStore((state) => state.setSyncIntervalMinutes);
  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const disabled = busy || status === "syncing";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await queryClient.invalidateQueries();
    } catch (cause) {
      setActionError(cause instanceof ContentServerError && cause.status === 403 ? t("contentSync.blocked") : describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const matches = catalog.filter((entry) =>
    `${entry.manifest.novel.name} ${entry.manifest.chapter.name}`
      .toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );

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
      {syncMode === "periodic" ? (
        <SettingsFieldRow label={t("contentSync.interval")}>
          <NumberInput aria-label={t("contentSync.interval")} value={syncIntervalMinutes}
            min={1} max={1440} allowDecimal={false} allowNegative={false}
            onChange={(value) => { if (typeof value === "number") setSyncIntervalMinutes(value); }} />
        </SettingsFieldRow>
      ) : null}
      <Group>
        <TextButton loading={disabled} disabled={!serverUrl} onClick={() => { void run(syncContentServer); }}>
          {t("contentSync.syncNow")}
        </TextButton>
        <TextButton disabled={disabled || !serverUrl} onClick={() => { void run(() => syncContentServer(true, true)); }}>
          {t("contentSync.rescan")}
        </TextButton>
      </Group>
      <Text size="sm" c="dimmed">{t("contentSync.rescanDescription")}</Text>
      {actionError || error ? <Alert color="red" role="alert">{actionError || (blocked ? t("contentSync.blocked") : error)}</Alert> : null}
      <SettingsFieldRow label={t("contentSync.catalog")} layout="stacked">
        <Stack gap="sm">
          <TextInput label={t("contentSync.search")} value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          <Text size="sm" c="dimmed">{t("contentSync.catalogCount", { count: matches.length })}</Text>
          {matches.slice(0, 50).map((entry) => (
            <Stack key={entry.id} gap="xs">
              <Text fw={500}>{entry.manifest.novel.name}</Text>
              <Text size="sm">{entry.manifest.chapter.name}</Text>
              <Group gap="xs">
                {entry.deleted ? <Text size="sm" c="dimmed">{t("contentSync.deleted")}</Text> : (
                  <TextButton size="sm" disabled={disabled} onClick={() => { void run(async () => {
                    const local = await downloadServerChapter(entry);
                    await navigate({ to: "/novel", search: { id: local.novelId } });
                  }); }}>
                    {t("contentSync.download")}
                  </TextButton>
                )}
                {entry.deleted ? (
                  <TextButton size="sm" disabled={disabled} onClick={() => { void run(() => restoreServerChapter(entry)); }}>
                    {t("contentSync.restore")}
                  </TextButton>
                ) : (
                  <TextButton size="sm" tone="danger" disabled={disabled} onClick={() => {
                    if (window.confirm(t("contentSync.deleteConfirm", { chapter: entry.manifest.chapter.name }))) {
                      void run(() => deleteServerChapter(entry));
                    }
                  }}>{t("contentSync.deleteServer")}</TextButton>
                )}
              </Group>
            </Stack>
          ))}
          {matches.length > 50 ? <Text size="sm">{t("contentSync.refineSearch")}</Text> : null}
        </Stack>
      </SettingsFieldRow>
    </SettingsSection>
  );
}
