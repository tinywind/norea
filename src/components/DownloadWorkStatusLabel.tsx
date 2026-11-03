import { useTranslation, type TranslationKey } from "../i18n";

/** The one state a novel's Downloads row shows; "attention" means it needs the user. */
export type DownloadWorkStatus = "preparing" | "downloading" | "waiting" | "paused" | "attention" | "done";

const WORK_STATUS_KEYS: Readonly<Record<DownloadWorkStatus, TranslationKey>> = {
  preparing: "downloads.queue.status.preparing",
  downloading: "downloads.queue.status.downloading",
  waiting: "downloads.queue.status.waiting",
  paused: "downloads.queue.status.paused",
  attention: "downloads.queue.status.attention",
  done: "downloads.queue.status.done",
};

export function DownloadWorkStatusLabel({ status }: { status: DownloadWorkStatus }) {
  const { t } = useTranslation();
  return (
    <span className="norea-task-work-status" data-status={status}>
      {t(WORK_STATUS_KEYS[status])}
    </span>
  );
}
