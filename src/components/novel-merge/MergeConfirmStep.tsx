import { Alert, Button, Text } from "@mantine/core";
import { useTranslation, type TranslationKey } from "../../i18n";
import type { NovelMergeDecisionSummary } from "./merge-map-rows";

interface MergeConfirmStepProps {
  error: string | null;
  onConfirm: () => void;
  pending: boolean;
  sourceName: string;
  sourcePluginName: string;
  summary: NovelMergeDecisionSummary;
  targetName: string;
  targetPluginName: string;
}

const SUMMARY_ROWS: readonly {
  key: keyof NovelMergeDecisionSummary;
  label: TranslationKey;
  /** Shown only when the count is above zero. */
  optional?: boolean;
}[] = [
  { key: "mapped", label: "novelMerge.confirm.mapped" },
  { key: "excluded", label: "novelMerge.confirm.excluded" },
  { key: "copyChoices", label: "novelMerge.confirm.copyChoices", optional: true },
  { key: "downloadsMoved", label: "novelMerge.confirm.downloadsMoved" },
  { key: "downloadsRemoved", label: "novelMerge.confirm.downloadsRemoved", optional: true },
  { key: "readMoved", label: "novelMerge.confirm.readMoved" },
  { key: "readDropped", label: "novelMerge.confirm.readDropped", optional: true },
];

export function MergeConfirmStep({
  error,
  onConfirm,
  pending,
  sourceName,
  sourcePluginName,
  summary,
  targetName,
  targetPluginName,
}: MergeConfirmStepProps) {
  const { t } = useTranslation();

  return (
    <div className="norea-merge-confirm">
      <div className="norea-merge-step-body">
        <section className="norea-merge-confirm-card norea-surface">
          <div className="norea-merge-confirm-novels">
            <div>
              <Text c="dimmed" size="xs">
                {t("novelMerge.confirm.from", { source: sourcePluginName })}
              </Text>
              <Text fw="var(--norea-weight-bold)">{sourceName}</Text>
            </div>
            <div>
              <Text c="dimmed" size="xs">
                {t("novelMerge.confirm.to", { source: targetPluginName })}
              </Text>
              <Text fw="var(--norea-weight-bold)">{targetName}</Text>
            </div>
          </div>
          <dl className="norea-merge-confirm-counts">
            {SUMMARY_ROWS.filter((row) => !row.optional || summary[row.key] > 0).map(
              (row) => (
                <div key={row.key}>
                  <dt>{t(row.label)}</dt>
                  <dd>{summary[row.key]}</dd>
                </div>
              ),
            )}
          </dl>
          <Alert color="warn" variant="light">
            {t("novelMerge.confirm.warning", { source: sourceName, target: targetName })}
          </Alert>
          {error ? (
            <Alert color="danger" title={t("novelMerge.mergeFailed")}>
              {error}
            </Alert>
          ) : null}
        </section>
      </div>
      <footer className="norea-merge-footer">
        <Button color="danger" loading={pending} onClick={onConfirm}>
          {pending ? t("novelMerge.merging") : t("novelMerge.confirmation.confirm")}
        </Button>
      </footer>
    </div>
  );
}
