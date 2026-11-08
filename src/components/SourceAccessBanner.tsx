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

export interface SourceAccessBannerEntry {
  block: SourceAccessBlock;
  sourceNames?: readonly string[];
}

function blockHostname(block: SourceAccessBlock): string {
  try { return new URL(block.challenge.url).hostname; }
  catch { return block.sourceId; }
}

/** The same compact access warning and recovery controls on every waiting surface. */
export function SourceAccessBanner(props: SourceAccessBannerEntry) {
  return <SourceAccessBannerGroup entries={[props]} />;
}

/** A shared warning still recovers only the source the user explicitly chooses. */
export function SourceAccessBannerGroup({ entries }: {
  entries: readonly SourceAccessBannerEntry[];
}) {
  const { t } = useTranslation();
  const browserVisible = useSiteBrowserStore(state => state.visible);
  if (entries.length === 0) return null;

  const grouped = entries.length > 1;
  const firstBlock = entries[0].block;
  const hostname = blockHostname(firstBlock);
  const title = t(sourceAccessChallengeTitleKey(firstBlock.challenge.kind));
  const labels = entries.map(({ block, sourceNames }) =>
    sourceNames?.length ? sourceNames.join(", ") : grouped ? block.sourceId : blockHostname(block));
  const members = entries.map(({ block }, index) => {
    const label = labels[index];
    const sourceLabel = labels.some((other, otherIndex) => otherIndex !== index && other === label)
      ? `${label} (${block.sourceId})` : label;
    const verifying = block.verificationTaskId !== undefined;
    const canOpenVerification = taskScheduler.canOpenSourceAccessBrowser(block.scopeKey);
    return {
      block, sourceLabel, verifying, canOpenVerification,
      verifyDisabled: browserVisible || verifying || !canOpenVerification,
    };
  });
  const sourceLabel = members.map(member => member.sourceLabel).join(", ");
  const candidates = members.filter(member => !member.verifying && member.canOpenVerification);
  const verifying = members.filter(member => member.verifying);
  const directCandidate = candidates.length === 1 ? candidates[0] : undefined;
  const verify = (member: (typeof members)[number]) => {
    void openSourceAccessBrowser(member.block, { sourceName: member.sourceLabel, title });
  };
  const chooseLabel = t("sourceAccess.chooseSourceToVerify");

  return (
    <section className="norea-source-access-banner"
      data-source-access={members.map(member => member.block.scopeKey).join(" ")} role="alert">
      <div className="norea-source-access-copy">
        <Text component="h3" fw="var(--norea-weight-bold)" size="sm">{title} · {hostname}</Text>
        {grouped ? (
          <Text c="dimmed" component="p" size="sm">{t("sourceAccess.affectedSources", { sources: sourceLabel })}</Text>
        ) : null}
        <Text c="dimmed" component="p" size="sm">
          {firstBlock.challenge.kind === "forbidden"
            ? t("sourceAccess.forbiddenMessage")
            : t("sourceAccess.scopeBlocked", { sources: sourceLabel })}
        </Text>
        {members.filter(member => member.block.verificationError).map(member => (
          <Text c="danger" component="p" key={member.block.scopeKey} size="sm">
            {grouped ? `${member.sourceLabel} · ` : null}
            {t("sourceAccess.verificationFailed", { error: member.block.verificationError! })}
          </Text>
        ))}
        {grouped && verifying.length > 0 ? (
          <Text c="dimmed" component="p" size="sm">
            {t("sourceAccess.verifyingSources", { sources: verifying.map(member => member.sourceLabel).join(", ") })}
          </Text>
        ) : null}
        {members.filter(member => member.block.verificationRequested && !member.verifying).map(member => (
          <Text c="dimmed" component="p" key={member.block.scopeKey} size="sm">
            {grouped ? `${member.sourceLabel} · ` : null}{t("sourceAccess.verifyNextRequest")}
          </Text>
        ))}
      </div>
      <div className="norea-source-access-actions">
        {candidates.length > 1 ? (
          <OverflowMenu
            items={candidates.map(member => ({
              label: t("downloads.queue.verifySource", { source: member.sourceLabel }),
              disabled: member.verifyDisabled,
              onClick: () => verify(member),
            }))}
            label={chooseLabel}
            trigger={<IconButton disabled={browserVisible} label={chooseLabel} size="lg"><VerifyIcon /></IconButton>}
          />
        ) : (
          <IconButton
            disabled={!directCandidate || directCandidate.verifyDisabled}
            label={t("downloads.queue.verifySource", { source: directCandidate?.sourceLabel ?? sourceLabel })}
            loading={candidates.length === 0 && verifying.length > 0}
            onClick={() => { if (directCandidate) verify(directCandidate); }}
            size="lg"
          >
            <VerifyIcon />
          </IconButton>
        )}
        <OverflowMenu items={members.flatMap(member => [
          { label: grouped ? `${member.sourceLabel} · ${t("sourceAccess.verifyAndResume")}` : t("sourceAccess.verifyAndResume"),
            disabled: member.verifyDisabled,
            onClick: () => applySourceAccessBrowserOutcome(taskScheduler, member.block, "verify") },
          { label: grouped ? `${member.sourceLabel} · ${t("sourceAccess.forceStopAndContinue")}` : t("sourceAccess.forceStopAndContinue"),
            danger: true,
            onClick: () => cancelSourceAccessWait(member.block.scopeKey, member.block.revision) },
        ])} label={t("downloads.queue.verifyOptions", { source: sourceLabel })} />
      </div>
    </section>
  );
}
