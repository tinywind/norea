import { VisuallyHidden } from "@mantine/core";
import type { CSSProperties } from "react";
import { useTranslation, type TranslationKey } from "../i18n";
import type { DownloadGoalOfflineState } from "../lib/download-goals/goal-offline-state";
import "../styles/chapter-count-badges.css";
import { DownloadedIcon, DownloadIcon, UnreadIcon, WarningIcon } from "./ui/icons";

const OFFLINE_STATE_LABELS: Record<DownloadGoalOfflineState, TranslationKey> = {
  ready: "library.grid.offline.ready",
  downloading: "library.grid.offline.downloading",
  attention: "library.grid.offline.attention",
};

const OFFLINE_STATE_ICONS = { ready: DownloadedIcon, downloading: DownloadIcon, attention: WarningIcon };

interface ChapterCountBadgesProps {
  downloaded: number;
  unread: number;
  offlineState?: DownloadGoalOfflineState;
  showDownloaded?: boolean;
  showUnread?: boolean;
}

export function ChapterCountBadges({
  downloaded,
  unread,
  offlineState,
  showDownloaded = true,
  showUnread = true,
}: ChapterCountBadgesProps) {
  return (
    <span className="norea-library-badge-group">
      {showDownloaded ? <DownloadedBadge count={downloaded} state={offlineState} /> : null}
      {showUnread && unread > 0 ? <UnreadBadge count={unread} /> : null}
    </span>
  );
}

export function UnreadBadge({ count }: { count: number }) {
  const { locale, t } = useTranslation();
  const label = t("library.grid.unreadBadge", { count });
  return (
    <span className="norea-library-badge" data-kind="unread" title={label}>
      <UnreadIcon size="0.875rem" />
      <span aria-hidden="true">{count.toLocaleString(locale)}</span>
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}

export function DownloadedBadge({ count, state }: { count: number; state?: DownloadGoalOfflineState }) {
  const { locale, t } = useTranslation();
  if (!count && !state) return null;
  const countLabel = t("library.grid.downloadedBadge", { count });
  const label = state ? `${countLabel} · ${t(OFFLINE_STATE_LABELS[state])}` : countLabel;
  const Icon = OFFLINE_STATE_ICONS[state ?? "ready"];
  return (
    <span className="norea-library-badge" data-goal-state={state} data-kind="downloaded" title={label}>
      <Icon size="0.875rem" />
      <span aria-hidden="true">{count.toLocaleString(locale)}</span>
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}

export function readingPercent(progress: number) {
  return Math.max(0, Math.min(100, Math.round(progress)));
}

export function CoverReadingProgress({ progress, decorative = false }: { progress: number; decorative?: boolean }) {
  const { t } = useTranslation();
  const percent = readingPercent(progress);
  if (percent <= 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="norea-library-card-progress"
        style={{ "--norea-library-progress": `${percent}%` } as CSSProperties}
      />
      {decorative ? null : <VisuallyHidden>{t("library.grid.readPercent", { progress: percent })}</VisuallyHidden>}
    </>
  );
}
