import { useState } from "react";
import { Alert, Group, PasswordInput, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import type { ContentStateValue } from "../lib/content-sync/client";
import {
  deleteServerChapter,
  downloadServerChapter,
  loginContentServer,
  logoutContentServer,
  restoreServerChapter,
  resolveContentState,
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
  const autoSync = useContentSyncStore((state) => state.autoSync);
  const status = useContentSyncStore((state) => state.status);
  const error = useContentSyncStore((state) => state.error);
  const user = useContentSyncStore((state) => state.user);
  const catalog = useContentSyncStore((state) => state.catalog);
  const conflicts = useContentSyncStore((state) => state.conflicts);
  const setServerUrl = useContentSyncStore((state) => state.setServerUrl);
  const setDeviceName = useContentSyncStore((state) => state.setDeviceName);
  const setAutoSync = useContentSyncStore((state) => state.setAutoSync);
  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mergeMode, setMergeMode] = useState<"merge" | "server">("merge");
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
      setActionError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const matches = catalog.filter((entry) =>
    `${entry.manifest.novel.name} ${entry.manifest.chapter.name}`
      .toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );

  function stateDescription(value: ContentStateValue): string {
    if ("deleted" in value) return t(value.deleted ? "contentSync.removed" : "contentSync.added");
    if ("unread" in value) return t(value.unread ? "contentSync.unread" : "contentSync.read");
    return t("contentSync.position", { chapter: value.chapterPath, progress: Math.round(value.progress) });
  }

  function conflictTitle(key: string): string {
    const identity = key.slice(key.indexOf(":") + 1);
    try {
      const [pluginId, novelPath, chapterPath] = JSON.parse(identity) as string[];
      const entry = catalog.find((item) => item.manifest.identity.pluginId === pluginId
        && item.manifest.identity.novelPath === novelPath
        && (!chapterPath || item.manifest.identity.chapterPath === chapterPath));
      return entry ? `${entry.manifest.novel.name} · ${entry.manifest.chapter.name}` : novelPath;
    } catch {
      return t("contentSync.conflicts");
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
      <SettingsFieldRow label={t("contentSync.autoSync")} description={t("contentSync.autoSyncDescription")}>
        <Switch aria-label={t("contentSync.autoSync")} checked={autoSync}
          disabled={disabled || !serverUrl} onChange={(event) => setAutoSync(event.currentTarget.checked)} />
      </SettingsFieldRow>
      {user ? (
        <SettingsFieldRow label={t("contentSync.signedIn", { username: user.username })}>
          <TextButton disabled={disabled} onClick={() => { void run(logoutContentServer); }}>
            {t("contentSync.logout")}
          </TextButton>
        </SettingsFieldRow>
      ) : (
        <SettingsFieldRow label={t("contentSync.account")} description={t("contentSync.sessionDescription")} layout="stacked">
          <Stack gap="xs">
            <TextInput label={t("contentSync.username")} value={username} autoComplete="username"
              disabled={disabled} onChange={(event) => setUsername(event.currentTarget.value)} />
            <PasswordInput label={t("contentSync.password")} value={password} autoComplete="current-password"
              disabled={disabled} onChange={(event) => setPassword(event.currentTarget.value)} />
            <Select label={t("contentSync.loginMode")} value={mergeMode} disabled={disabled}
              data={[{ value: "merge", label: t("contentSync.merge") }, { value: "server", label: t("contentSync.serverState") }]}
              onChange={(value) => { if (value === "merge" || value === "server") setMergeMode(value); }} />
            <Text size="sm" c="dimmed">{t("contentSync.mergeDescription")}</Text>
            <TextButton disabled={disabled || !serverUrl || !username.trim() || !password} onClick={() => {
              void run(async () => {
                await loginContentServer(username.trim(), password, mergeMode);
                setPassword("");
              });
            }}>{t("contentSync.login")}</TextButton>
          </Stack>
        </SettingsFieldRow>
      )}
      <Group>
        <TextButton loading={disabled} disabled={!serverUrl} onClick={() => { void run(syncContentServer); }}>
          {t("contentSync.syncNow")}
        </TextButton>
      </Group>
      {actionError || error ? <Alert color="red" role="alert">{actionError || error}</Alert> : null}
      {conflicts.length ? (
        <SettingsFieldRow label={t("contentSync.conflicts")} description={t("contentSync.conflictsDescription")} layout="stacked">
          <Stack gap="sm">
            {conflicts.map((entry) => (
              <Stack key={entry.key} gap="xs">
                <Text fw={500}>{conflictTitle(entry.key)}</Text>
                <Text size="sm">{stateDescription(entry.value)}</Text>
                <TextButton disabled={disabled} onClick={() => { void run(() => resolveContentState(entry.key, entry.value)); }}>
                  {t("contentSync.keepCurrent")}
                </TextButton>
                {entry.conflicts.map((candidate) => (
                  <Stack key={candidate.operationId} gap="xs">
                    <Text size="sm">{candidate.deviceName}: {stateDescription(candidate.value)}</Text>
                    <TextButton disabled={disabled} onClick={() => { void run(() => resolveContentState(entry.key, candidate.value)); }}>
                      {t("contentSync.useCandidate")}
                    </TextButton>
                  </Stack>
                ))}
              </Stack>
            ))}
          </Stack>
        </SettingsFieldRow>
      ) : null}
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
                {user?.role === "admin" ? entry.deleted ? (
                  <TextButton size="sm" disabled={disabled} onClick={() => { void run(() => restoreServerChapter(entry)); }}>
                    {t("contentSync.restore")}
                  </TextButton>
                ) : (
                  <TextButton size="sm" tone="danger" disabled={disabled} onClick={() => {
                    if (window.confirm(t("contentSync.deleteConfirm", { chapter: entry.manifest.chapter.name }))) {
                      void run(() => deleteServerChapter(entry));
                    }
                  }}>{t("contentSync.deleteServer")}</TextButton>
                ) : null}
              </Group>
            </Stack>
          ))}
          {matches.length > 50 ? <Text size="sm">{t("contentSync.refineSearch")}</Text> : null}
        </Stack>
      </SettingsFieldRow>
    </SettingsSection>
  );
}
