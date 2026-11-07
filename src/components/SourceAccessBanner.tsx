import { Text } from "@mantine/core";
import { useTranslation } from "../i18n";
import { sourceAccessChallengeTitleKey } from "../lib/plugins/source-access";
import { taskScheduler } from "../lib/tasks/scheduler";
import {
  applySourceAccessBrowserOutcome,
  cancelSourceAccessWait,
  openSourceAccessBrowser,
} from "../lib/tasks/source-access-coordinator";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";
import { useSiteBrowserStore } from "../store/site-browser";
import { IconButton } from "./IconButton";
import { OverflowMenu } from "./ui/OverflowMenu";
import { VerifyIcon } from "./ui/icons";

/** The same compact access warning and recovery controls on every waiting surface. */
export function SourceAccessBanner({ block, sourceNames = [] }: {
  block: SourceAccessBlock;
  sourceNames?: readonly string[];
}) {
  const { t } = useTranslation();
  const browserVisible = useSiteBrowserStore(state => state.visible);
  const hostname = (() => {
    try { return new URL(block.challenge.url).hostname; }
    catch { return block.sourceId; }
  })();
  const sourceLabel = sourceNames.length > 0 ? sourceNames.join(", ") : hostname;
  const title = t(sourceAccessChallengeTitleKey(block.challenge.kind));
  const verifying = block.verificationRequested || block.verificationTaskId !== undefined;
  const canOpenVerification = taskScheduler.canBeginSourceAccessVerification(block.scopeKey);
  const verifyDisabled = browserVisible || verifying || !canOpenVerification;

  return (
    <section className="norea-source-access-banner" data-source-access={block.scopeKey} role="alert">
      <div className="norea-source-access-copy">
        <Text component="h3" fw="var(--norea-weight-bold)" size="sm">{title} · {hostname}</Text>
        <Text c="dimmed" component="p" size="sm">
          {block.challenge.kind === "forbidden"
            ? t("sourceAccess.forbiddenMessage")
            : t("sourceAccess.scopeBlocked", { sources: sourceLabel })}
        </Text>
        {block.verificationError ? (
          <Text c="danger" component="p" size="sm">
            {t("sourceAccess.verificationFailed", { error: block.verificationError })}
          </Text>
        ) : null}
        {!verifying && !canOpenVerification ? (
          <Text c="dimmed" component="p" size="sm">{t("sourceAccess.queueTaskToVerify")}</Text>
        ) : null}
      </div>
      <div className="norea-source-access-actions">
        <IconButton disabled={verifyDisabled} label={t("downloads.queue.verifySource", { source: sourceLabel })}
          loading={verifying} onClick={() => { void openSourceAccessBrowser(block, { sourceName: sourceLabel, title }); }} size="lg">
          <VerifyIcon />
        </IconButton>
        <OverflowMenu items={[
          { label: t("sourceAccess.verifyAndResume"), disabled: verifyDisabled,
            onClick: () => applySourceAccessBrowserOutcome(taskScheduler, block, "verify") },
          { label: t("sourceAccess.forceStopAndContinue"), danger: true,
            onClick: () => cancelSourceAccessWait(block.scopeKey, block.revision) },
        ]} label={t("downloads.queue.verifyOptions", { source: sourceLabel })} />
      </div>
    </section>
  );
}
