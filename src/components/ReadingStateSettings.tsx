import { useEffect, useRef, useState } from "react";
import { Alert, PasswordInput, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { copyTextToClipboard } from "../lib/clipboard";
import { ContentServerError } from "../lib/content-sync/client";
import {
  createReadingSyncKey, readReadingSyncKey, ReadingSyncError, saveReadingSyncKey, syncReadingState,
  validReadingSyncKey, type ReadingSyncMode, type ReadingSyncProgress, type ReadingSyncResult,
} from "../lib/content-sync/reading-state";
import { SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";

export function ReadingStateSettings({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [savedKey, setSavedKey] = useState(() => readReadingSyncKey(serverUrl));
  const [keyDraft, setKeyDraft] = useState(savedKey);
  const [mode, setMode] = useState<ReadingSyncMode | null>(null);
  const [progress, setProgress] = useState<ReadingSyncProgress | null>(null);
  const [result, setResult] = useState<ReadingSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = mode !== null;
  const keyChanged = keyDraft.trim().toLowerCase() !== savedKey;
  const canSync = Boolean(serverUrl) && validReadingSyncKey(savedKey) && !keyChanged && !busy;

  useEffect(() => () => { abort.current?.abort(); }, []);

  function showError(cause: unknown) {
    setError(cause instanceof ReadingSyncError ? t(`readingSync.${cause.code}`)
      : cause instanceof ContentServerError && cause.status === 403 ? t("contentSync.blocked") : describeError(cause));
  }

  function saveKey(value: string) {
    setError(null); setResult(null); setProgress(null); setNotice(null);
    try {
      const key = saveReadingSyncKey(serverUrl, value);
      setSavedKey(key); setKeyDraft(key); setNotice(t("readingSync.keySaved"));
    } catch (cause) { showError(cause); }
  }

  async function start(nextMode: ReadingSyncMode) {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setMode(nextMode); setError(null); setNotice(null); setResult(null); setProgress(null);
    try {
      setResult(await syncReadingState(serverUrl, savedKey, nextMode, setProgress, controller.signal));
    } catch (cause) {
      if (controller.signal.aborted) setError(t("readingSync.cancelled"));
      else showError(cause);
    } finally {
      // Even a later network failure can follow committed batches; refresh their real state.
      if (nextMode !== "push") {
        await Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: ["novel"] }),
          queryClient.invalidateQueries({ queryKey: ["chapter"] }),
          queryClient.invalidateQueries({ queryKey: ["category"] }),
        ]);
      }
      abort.current = null; setMode(null);
    }
  }

  return (
    <SettingsSection title={t("readingSync.title")} description={t("readingSync.description")}>
      <SettingsFieldRow label={t("readingSync.key")} description={t("readingSync.keyDescription")} layout="stacked">
        <PasswordInput aria-label={t("readingSync.key")} value={keyDraft} autoComplete="off"
          disabled={busy || !serverUrl} placeholder={t("readingSync.keyPlaceholder")}
          onChange={event => { setKeyDraft(event.currentTarget.value); setNotice(null); }} />
        <SettingsInlineControls>
          {!savedKey ? <TextButton disabled={busy || !serverUrl} onClick={() => saveKey(createReadingSyncKey())}>
            {t("readingSync.createKey")}
          </TextButton> : null}
          <TextButton disabled={busy || !serverUrl || !keyChanged} onClick={() => saveKey(keyDraft)}>
            {t("readingSync.saveKey")}
          </TextButton>
          <TextButton disabled={busy || !savedKey || keyChanged} onClick={() => {
            setError(null);
            setNotice(null);
            void copyTextToClipboard(savedKey)
              .then(() => setNotice(t("readingSync.keyCopied")))
              .catch(() => setError(t("readingSync.copyFailed")));
          }}>{t("readingSync.copyKey")}</TextButton>
        </SettingsInlineControls>
        {notice ? <Text role="status" size="sm">{notice}</Text> : null}
      </SettingsFieldRow>
      <SettingsFieldRow label={t("readingSync.actions")} description={t("readingSync.mergePolicy")} layout="stacked">
        <SettingsInlineControls>
          <TextButton tone="accent" disabled={!canSync} loading={mode === "pull"} onClick={() => { void start("pull"); }}>
            {t("readingSync.pull")}
          </TextButton>
          <TextButton disabled={!canSync} loading={mode === "push"} onClick={() => { void start("push"); }}>
            {t("readingSync.push")}
          </TextButton>
          <TextButton disabled={!canSync} loading={mode === "merge"} onClick={() => { void start("merge"); }}>
            {t("readingSync.merge")}
          </TextButton>
          {busy ? <TextButton onClick={() => abort.current?.abort()}>{t("common.cancel")}</TextButton> : null}
        </SettingsInlineControls>
        {!serverUrl ? <Text size="sm">{t("readingSync.serverRequired")}</Text> : null}
        {keyChanged ? <Text size="sm">{t("readingSync.saveFirst")}</Text> : null}
        {busy && progress ? <Text role="status">{t(progress.phase === "upload" ? "readingSync.uploading" : "readingSync.downloading", { count: progress.phase === "upload" ? progress.uploaded : progress.downloaded })}</Text> : null}
        {result ? <Alert color="green" role="status">
          {t("readingSync.result", { uploaded: result.uploaded, serverUpdated: result.serverUpdated, downloaded: result.downloaded, localUpdated: result.localUpdated })}
          {result.skipped > 0 ? <Text size="sm">{t("readingSync.skipped", { count: result.skipped })}</Text> : null}
          {result.uploaded === 0 && result.downloaded === 0 ? <Text size="sm">{t("readingSync.empty")}</Text> : null}
        </Alert> : null}
        {error ? <Alert color="red" role="alert">
          {error}
          {progress && (progress.uploaded > 0 || progress.downloaded > 0) ? <Text size="sm">{t("readingSync.partial", { uploaded: progress.uploaded, localUpdated: progress.localUpdated })}</Text> : null}
        </Alert> : null}
      </SettingsFieldRow>
    </SettingsSection>
  );
}
