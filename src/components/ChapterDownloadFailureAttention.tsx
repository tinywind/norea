import { useRef, useState } from "react";
import { Button, Group, Text } from "@mantine/core";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import { pluginManager } from "../lib/plugins/manager";
import { retryFailedChapterDownloads } from "../lib/tasks/chapter-download";
import {
  chapterDownloadFailureAttention,
  type ChapterDownloadFailureGroup,
} from "../lib/tasks/chapter-download-failure-attention";
import { forgetChapterDownloadFailures } from "../lib/tasks/chapter-download-failures";
import type { DownloadFailureClass } from "../lib/tasks/download-failure";
import { useChapterDownloadFailureSnapshot } from "../lib/tasks/hooks";
import { enqueueOpenSiteTask } from "../lib/tasks/source-tasks";
import { resumeVpnDownloadRange } from "../lib/tasks/vpn-download-runtime";

const MESSAGE_KEYS: Readonly<Record<DownloadFailureClass, TranslationKey>> = {
  transient: "downloads.failures.transient",
  content: "downloads.failures.content",
  storage: "downloads.failures.storage",
  challenge: "downloads.failures.challenge",
  "media-incomplete": "downloads.failures.mediaIncomplete",
};

const ACTION_KEYS: Readonly<Record<ChapterDownloadFailureGroup["action"], TranslationKey>> = {
  retry: "downloads.failures.retryAll",
  repair: "downloads.failures.repairAll",
  verify: "vpnDownload.attention.verify",
};

async function retryGroup(group: ChapterDownloadFailureGroup): Promise<void> {
  await retryFailedChapterDownloads(group.chapterIds);
  if (group.vpnRanges.length === 0) return;
  // A fresh pass of the range retries its paused chapter with a new budget.
  await forgetChapterDownloadFailures(group.chapterIds);
  for (const { planId, rangeId } of group.vpnRanges) await resumeVpnDownloadRange(planId, rangeId);
}

async function verifyGroup(group: ChapterDownloadFailureGroup, title: string): Promise<void> {
  const plugin = pluginManager.getPlugin(group.pluginId);
  if (plugin && group.challengeUrl) {
    // The site browser shares the source's session, so a solved challenge reaches its downloads.
    await enqueueOpenSiteTask(plugin, group.challengeUrl, title).promise.catch(() => undefined);
  }
  await retryGroup(group);
}

/** How many failed chapters wait for an automatic retry; a status line, not something the user must act on. */
export function ChapterDownloadRetryingStatus() {
  const { t } = useTranslation();
  const { retrying } = chapterDownloadFailureAttention(useChapterDownloadFailureSnapshot());
  if (retrying === 0) return null;
  return (
    <Text c="dimmed" role="status" size="sm" data-download-failures="retrying">
      {t("downloads.failures.retrying", { count: retrying })}
    </Text>
  );
}

/** Needs attention lines for persisted chapter failures, one action per source and failure class. */
export function ChapterDownloadFailureAttention() {
  const { t } = useTranslation();
  const rows = useChapterDownloadFailureSnapshot();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const busy = useRef(false);
  const attention = chapterDownloadFailureAttention(rows);
  if (attention.groups.length === 0) return null;

  async function act(key: string, action: () => Promise<void>): Promise<void> {
    if (busy.current) return;
    busy.current = true; setPending(key); setError(null);
    try { await action(); }
    catch (actionError) { setError({ key, message: describeError(actionError) }); }
    finally { busy.current = false; setPending(null); }
  }

  return (
    <>
      {attention.groups.map((group) => {
        const source = pluginManager.getPlugin(group.pluginId)?.name ?? group.pluginId;
        const message = t(MESSAGE_KEYS[group.failureClass], { source, count: group.chapterIds.length, host: group.challengeHost });
        return (
          <section className="norea-source-access-banner" data-download-failures={group.failureClass} key={group.key} role="alert">
            <div className="norea-source-access-copy">
              <Text component="h3" fw={700} size="sm">{message}</Text>
              <Text c="dimmed" component="p" lineClamp={2} size="xs">
                {t("downloads.failures.latest", { message: group.latestSummary })}
              </Text>
              {error?.key === group.key ? <Text c="danger" component="p" size="sm">{error.message}</Text> : null}
            </div>
            <Group gap="xs" justify="flex-end">
              <Button
                disabled={pending !== null}
                loading={pending === group.key}
                onClick={() => act(group.key, () => group.action === "verify" ? verifyGroup(group, message) : retryGroup(group))}
                size="xs"
                variant="light"
              >
                {t(ACTION_KEYS[group.action])}
              </Button>
            </Group>
          </section>
        );
      })}
    </>
  );
}
