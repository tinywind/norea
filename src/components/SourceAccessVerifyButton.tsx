import { Button, Text } from "@mantine/core";
import { useTranslation } from "../i18n";
import { useTaskSnapshot } from "../lib/tasks/hooks";
import { taskScheduler } from "../lib/tasks/scheduler";
import { openSourceAccessBrowser } from "../lib/tasks/source-access-coordinator";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";
import { useSiteBrowserStore } from "../store/site-browser";
import { WarningIcon } from "./ui/icons";

/** Looks up the open source-access challenge of a source, if any. */
export function useSourceAccessBlocks(
  active: boolean,
): (pluginId: string) => SourceAccessBlock | undefined {
  const blocks = useTaskSnapshot(active).sourceAccessBlocks;
  return (pluginId) => blocks.find((block) => block.sourceId === pluginId);
}

interface SourceAccessVerifyButtonProps {
  block: SourceAccessBlock;
  label: string;
  sourceName: string;
}

/** Opens the source-access browser for a blocked source's challenge. */
export function SourceAccessVerifyButton({
  block,
  label,
  sourceName,
}: SourceAccessVerifyButtonProps) {
  const { t } = useTranslation();
  const browserVisible = useSiteBrowserStore((state) => state.visible);
  const verifying = block.verificationRequested || block.verificationTaskId !== undefined;

  return (
    <Button
      disabled={
        browserVisible ||
        verifying ||
        !taskScheduler.canBeginSourceAccessVerification(block.scopeKey)
      }
      loading={verifying}
      onClick={() => {
        void openSourceAccessBrowser(block, {
          sourceName,
          title:
            block.challenge.kind === "captcha"
              ? t("sourceAccess.captchaTitle")
              : t("sourceAccess.cloudflareTitle"),
        });
      }}
      size="compact-sm"
      variant="default"
    >
      {label}
    </Button>
  );
}

interface SourceAccessNoticeProps {
  active: boolean;
  /** Present the notice only while this is true, such as while work waits. */
  enabled?: boolean;
  sourceId: string;
  sourceName: string;
}

/**
 * Verify in place for a source whose work is held by an access check. The
 * scheduler keeps the blocked operation queued, so once the source-access
 * coordinator confirms access that same operation runs again by itself;
 * closing the site browser keeps it paused.
 */
export function SourceAccessNotice({
  active,
  enabled = true,
  sourceId,
  sourceName,
}: SourceAccessNoticeProps) {
  const { t } = useTranslation();
  const block = useSourceAccessBlocks(active)(sourceId);
  if (!enabled || !block) return null;

  return (
    <section className="norea-source-access-notice" role="status">
      <WarningIcon className="norea-source-access-notice-icon" size="1.25rem" />
      <div className="norea-source-access-notice-copy">
        <Text fw="var(--norea-weight-bold)" size="sm">
          {t("sourceAccess.notice.title", { source: sourceName })}
        </Text>
        <Text c="dimmed" size="sm">
          {t("sourceAccess.notice.message")}
        </Text>
      </div>
      <div className="norea-source-access-notice-actions">
        <SourceAccessVerifyButton
          block={block}
          label={t("updates.failure.verify")}
          sourceName={sourceName}
        />
      </div>
    </section>
  );
}
