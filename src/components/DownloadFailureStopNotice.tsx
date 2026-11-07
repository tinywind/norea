import { Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { pluginManager } from "../lib/plugins/manager";
import { describeError } from "../lib/errors";
import { resumeChapterDownloadQueueAfterFailure } from "../lib/tasks/chapter-download";
import { redactUrlsForLog } from "../lib/url-log";
import type { TaskSnapshot } from "../lib/tasks/task-types";
import { IconButton } from "./IconButton";
import { PlayIcon, SettingsIcon } from "./ui/icons";
import { useSettingsRevealStore } from "./settings/settings-reveal";

export function DownloadFailureStopNotice({ snapshot }: {
  snapshot: Pick<TaskSnapshot, "downloadFailureStops" | "records">;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);

  async function resume(sourceId?: string): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPending(sourceId === undefined ? "global" : `source:${sourceId}`);
    try {
      if (sourceId === undefined) await resumeChapterDownloadQueueAfterFailure();
      else await resumeChapterDownloadQueueAfterFailure(sourceId);
    } catch (error) {
      console.warn("[chapter-download] failed to resume queue:", redactUrlsForLog(describeError(error)));
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  const stops = snapshot.downloadFailureStops;
  if (!stops) return null;
  const rows: { sourceId?: string; source?: string; message: string }[] = [];
  if (stops.globalError) rows.push({ message: stops.globalError });
  for (const [sourceId, message] of Object.entries(stops.sourceErrors)) {
    const source = snapshot.records.find(record => record.source?.id === sourceId)?.source?.name ??
      pluginManager.getPlugin(sourceId)?.name ?? sourceId;
    rows.push({ sourceId, source, message });
  }
  return (
    <>
      {rows.map(({ sourceId, source, message }) => (
        <section className="norea-source-access-banner" data-download-failure-stop={sourceId ?? "global"} key={sourceId === undefined ? "global" : `source:${sourceId}`} role="alert">
          <div className="norea-source-access-copy">
            <Text component="h3" fw="var(--norea-weight-bold)" size="sm">
              {source ? t("downloads.stopped.source", { source }) : t("downloads.stopped.global")}
            </Text>
            <Text component="p" size="sm">{message}</Text>
            <Text c="dimmed" component="p" size="xs">{t("downloads.stopped.resumeHint")}</Text>
          </div>
          <div className="norea-source-access-actions">
            <IconButton
              disabled={pending !== null}
              loading={pending === (sourceId === undefined ? "global" : `source:${sourceId}`)}
              onClick={() => resume(sourceId)}
              size="lg"
              label={source ? t("downloads.queue.resumeSource", { source }) : t("downloads.queue.resume")}
            >
              <PlayIcon />
            </IconButton>
            <IconButton
              onClick={() => {
                useSettingsRevealStore.getState().reveal("downloads", t("settings.downloads.recovery.forbidden.label"));
                void navigate({ to: "/settings", search: { section: "downloads" } });
              }}
              size="lg"
              label={t("downloads.recoverySettings")}
            >
              <SettingsIcon />
            </IconButton>
          </div>
        </section>
      ))}
    </>
  );
}
