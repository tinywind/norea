import { Stack, Text } from "@mantine/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  getDownloadRecoverySnapshot,
  subscribeDownloadRecovery,
  type DownloadRecoveryState,
} from "../lib/tasks/download-recovery";

const STATUS_KEYS: Record<Exclude<DownloadRecoveryState["status"], "waiting">, TranslationKey> = {
  resetting: "downloads.recovery.resetting",
  retrying: "downloads.recovery.retrying",
  "switching-profile": "downloads.recovery.switchingProfile",
  held: "downloads.recovery.held",
};

export function DownloadRecoveryStatus() {
  const { t } = useTranslation();
  const episodes = useSyncExternalStore(subscribeDownloadRecovery, getDownloadRecoverySnapshot, getDownloadRecoverySnapshot);
  const [now, setNow] = useState(Date.now);
  const waiting = episodes.some(episode => episode.status === "waiting" && episode.nextRetryAt !== null);
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);

  if (episodes.length === 0) return null;
  return (
    <Stack gap="xs">
      {episodes.map(episode => (
        <section className="norea-source-access-banner" data-download-recovery={episode.key} key={episode.key} role="status">
          <div className="norea-source-access-copy">
            <Text component="h3" fw="var(--norea-weight-bold)" size="sm">{episode.title}</Text>
            <Text component="p" size="sm">
              {episode.status === "waiting"
                ? t("downloads.recovery.waiting", { seconds: Math.max(0, Math.ceil(((episode.nextRetryAt ?? now) - now) / 1_000)) })
                : t(STATUS_KEYS[episode.status])}
            </Text>
            <Text c="dimmed" component="p" size="xs">
              {t("downloads.recovery.attempts", { count: episode.retries, limit: episode.maxRetries })}
              {episode.action === "nextProfile" || episode.profileChanges > 0
                ? ` · ${t("downloads.recovery.profileChanges", { count: episode.profileChanges, limit: episode.maxProfileChanges })}`
                : null}
              {episode.siteResetCount > 0
                ? ` · ${t("downloads.recovery.siteResets", { count: episode.siteResetCount })}`
                : null}
            </Text>
          </div>
        </section>
      ))}
    </Stack>
  );
}
