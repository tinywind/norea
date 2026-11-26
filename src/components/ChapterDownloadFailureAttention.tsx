import { useRef, useState } from "react";
import { Group, Text } from "@mantine/core";
import { IconButton } from "./IconButton";
import { CloseIcon, DownloadIcon, RepairIcon, RetryIcon, VerifyIcon, WarningIcon } from "./ui/icons";
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

const ACTION_KEYS: Readonly<Record<Exclude<ChapterDownloadFailureGroup["action"], "none">, TranslationKey>> = {
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

/** Needs attention lines for persisted chapter failures, with recovery and dismiss actions per group. */
export function ChapterDownloadFailureAttention() {
  const { t } = useTranslation();
  const rows = useChapterDownloadFailureSnapshot();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const busy = useRef(false);
  const attention = chapterDownloadFailureAttention(rows);
  if (attention.groups.length === 0) return null;

  async function act(pendingKey: string, groupKey: string, action: () => Promise<void>): Promise<void> {
    if (busy.current) return;
    busy.current = true; setPending(pendingKey); setError(null);
    try { await action(); }
    catch (actionError) { setError({ key: groupKey, message: describeError(actionError) }); }
    finally { busy.current = false; setPending(null); }
  }

  return (
    <>
      {attention.groups.map((group) => {
        const source = pluginManager.getPlugin(group.pluginId)?.name ?? group.pluginId;
        const messageKey: TranslationKey = group.serverMissing
          ? group.action === "none"
            ? "downloads.failures.serverMissingNoSource"
            : "downloads.failures.serverMissing"
          : MESSAGE_KEYS[group.failureClass];
        const message = t(messageKey, { source, count: group.chapterIds.length, host: group.challengeHost });
        const actionPendingKey = `${group.key}:action`;
        const dismissPendingKey = `${group.key}:dismiss`;
        return (
          <section
            className="norea-source-access-banner"
            data-download-failures={group.failureClass}
            data-tone={group.serverMissing || group.failureClass === "challenge" ? "warn" : "danger"}
            key={group.key}
            role="alert"
          >
            <span aria-hidden="true" className="norea-source-access-icon">
              <WarningIcon size="1.25rem" />
            </span>
            <div className="norea-source-access-copy">
              <Text component="h3" fw="var(--norea-weight-bold)" size="sm">{message}</Text>
              {group.serverMissing ? null : (
                <Text c="dimmed" component="p" lineClamp={2} size="xs">
                  {t("downloads.failures.latest", { message: group.latestSummary })}
                </Text>
              )}
              {error?.key === group.key ? <Text c="danger" component="p" size="sm">{error.message}</Text> : null}
            </div>
            <Group gap="xs" justify="flex-end">
              {group.action !== "none" ? (
                <IconButton
                  disabled={pending !== null}
                  label={t(group.serverMissing ? "downloads.failures.downloadFromSource" : ACTION_KEYS[group.action])}
                  loading={pending === actionPendingKey}
                  onClick={() => act(actionPendingKey, group.key, () => group.action === "verify" ? verifyGroup(group, message) : retryGroup(group))}
                  size="lg"
                >
                  {group.serverMissing ? <DownloadIcon /> : group.action === "verify" ? <VerifyIcon /> : group.action === "repair" ? <RepairIcon /> : <RetryIcon />}
                </IconButton>
              ) : null}
              <IconButton
                disabled={pending !== null}
                label={t("downloads.failures.dismiss")}
                loading={pending === dismissPendingKey}
                onClick={() => act(dismissPendingKey, group.key, () => forgetChapterDownloadFailures(group.chapterIds))}
                size="lg"
              >
                <CloseIcon />
              </IconButton>
            </Group>
          </section>
        );
      })}
    </>
  );
}
