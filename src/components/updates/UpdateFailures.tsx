import { Button, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "../../i18n";
import type { SourceAccessBlock } from "../../lib/tasks/source-access-gate";
import type { UpdateCheckFailure } from "../../lib/updates/check-library-updates";
import {
  SourceAccessVerifyButton,
  useSourceAccessBlocks,
} from "../SourceAccessVerifyButton";
import { ChipButton } from "../ChipButton";
import { ChevronRightIcon, WarningIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

export interface FailedUpdateSource {
  failures: UpdateCheckFailure[];
  name: string;
  pluginId: string;
  pluginMissing: boolean;
}

/** One entry per failed source, in the order its first failure arrived. */
export function groupFailuresBySource(
  failures: readonly UpdateCheckFailure[],
): FailedUpdateSource[] {
  const sources = new Map<string, FailedUpdateSource>();
  for (const failure of failures) {
    const source = sources.get(failure.pluginId);
    if (source) {
      source.failures.push(failure);
      source.pluginMissing ||= failure.reason.kind === "plugin-missing";
      continue;
    }
    sources.set(failure.pluginId, {
      failures: [failure],
      name: failure.pluginName ?? failure.pluginId,
      pluginId: failure.pluginId,
      pluginMissing: failure.reason.kind === "plugin-missing",
    });
  }
  return [...sources.values()];
}

type Translate = ReturnType<typeof useTranslation>["t"];

function failureReason(failure: UpdateCheckFailure, t: Translate): string {
  return failure.reason.kind === "plugin-missing"
    ? t("updates.pluginMissing", { id: failure.reason.pluginId })
    : failure.reason.message;
}

function friendlyReason(
  source: FailedUpdateSource,
  block: SourceAccessBlock | undefined,
  t: Translate,
): string {
  if (source.pluginMissing) return t("updates.failure.pluginMissing");
  if (block) return t("updates.failure.verification");
  return t("updates.failure.error");
}

interface UpdateFailuresProps {
  active: boolean;
  onOpenNovel: (novelId: number) => void;
  /** Checks only these novels again. */
  onRetry: (novelIds: readonly number[]) => void;
  sources: readonly FailedUpdateSource[];
}

const novelIdsOf = (sources: readonly FailedUpdateSource[]) =>
  sources.flatMap((source) => source.failures.map((failure) => failure.novelId));

/**
 * The recovery surface for a finished check. One failed source shows its
 * action in place; more collapse into a chip that opens a sheet per source.
 * Retry checks only the failed novels: one source's, or all of them.
 */
export function UpdateFailures({
  active,
  onOpenNovel,
  onRetry,
  sources,
}: UpdateFailuresProps) {
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const blockFor = useSourceAccessBlocks(active);
  if (sources.length === 0) return null;

  const openNovel = (novelId: number) => {
    setSheetOpen(false);
    onOpenNovel(novelId);
  };
  const single = sources.length === 1 ? sources[0]! : null;
  const singleBlock = single ? blockFor(single.pluginId) : undefined;

  return (
    <>
      {single ? (
        <section className="norea-updates-failure-notice" role="status">
          <WarningIcon className="norea-updates-failure-icon" size="1.25rem" />
          <div className="norea-updates-failure-copy">
            <Text fw="var(--norea-weight-bold)" size="sm">
              {t("updates.failure.oneSource", { name: single.name })}
            </Text>
            <Text c="dimmed" size="sm">
              {friendlyReason(single, singleBlock, t)}
            </Text>
          </div>
          <div className="norea-updates-failure-actions">
            {singleBlock ? (
              <SourceAccessVerifyButton
                block={singleBlock}
                label={t("updates.failure.verify")}
                sourceName={single.name}
              />
            ) : single.pluginMissing && single.failures.length === 1 ? (
              <Button
                onClick={() => openNovel(single.failures[0]!.novelId)}
                size="compact-sm"
                variant="default"
              >
                {t("updates.openNovelAction")}
              </Button>
            ) : (
              <Button
                onClick={() => onRetry(novelIdsOf([single]))}
                size="compact-sm"
                variant="default"
              >
                {t("common.retry")}
              </Button>
            )}
            <Button
              onClick={() => setSheetOpen(true)}
              size="compact-sm"
              variant="subtle"
            >
              {t("common.details")}
            </Button>
          </div>
        </section>
      ) : (
        <div className="norea-updates-failure-chip-bar">
          <ChipButton
            aria-haspopup="dialog"
            onClick={() => setSheetOpen(true)}
            tone="danger"
            trailingIcon={<ChevronRightIcon />}
          >
            {t("updates.failure.chip", { count: sources.length })}
          </ChipButton>
        </div>
      )}

      <ResponsiveSheet
        footer={
          <Button
            fullWidth
            onClick={() => {
              setSheetOpen(false);
              onRetry(novelIdsOf(sources));
            }}
          >
            {t("updates.failure.retryAll")}
          </Button>
        }
        onClose={() => setSheetOpen(false)}
        opened={sheetOpen}
        title={t("updates.failure.sheetTitle")}
      >
        <div className="norea-updates-failure-sources">
          {sources.map((source) => {
            const block = blockFor(source.pluginId);
            return (
              <section
                aria-labelledby={`norea-updates-failed-${source.pluginId}`}
                className="norea-updates-failure-source"
                key={source.pluginId}
              >
                <div className="norea-updates-failure-source-header">
                  <Text
                    component="h3"
                    fw="var(--norea-weight-bold)"
                    id={`norea-updates-failed-${source.pluginId}`}
                    size="sm"
                  >
                    {source.name}
                  </Text>
                  {block ? (
                    <SourceAccessVerifyButton
                      block={block}
                      label={t("updates.failure.verify")}
                      sourceName={source.name}
                    />
                  ) : source.pluginMissing ? null : (
                    <Button
                      onClick={() => {
                        setSheetOpen(false);
                        onRetry(novelIdsOf([source]));
                      }}
                      size="compact-sm"
                      variant="default"
                    >
                      {t("common.retry")}
                    </Button>
                  )}
                </div>
                <Text c="dimmed" size="sm">
                  {friendlyReason(source, block, t)}
                </Text>
                <ul className="norea-updates-failure-novels">
                  {source.failures.map((failure) => (
                    <li key={failure.novelId}>
                      <Button
                        justify="space-between"
                        fullWidth
                        onClick={() => openNovel(failure.novelId)}
                        rightSection={<ChevronRightIcon size="1rem" />}
                        variant="subtle"
                      >
                        {t("updates.openNovel", { name: failure.novelName })}
                      </Button>
                    </li>
                  ))}
                </ul>
                <details className="norea-state-details">
                  <summary>{t("common.details")}</summary>
                  <Text c="dimmed" component="div" size="xs">
                    {source.failures.map((failure) => (
                      <div key={failure.novelId}>
                        {failure.novelName}: {failureReason(failure, t)}
                      </div>
                    ))}
                  </Text>
                </details>
              </section>
            );
          })}
        </div>
      </ResponsiveSheet>
    </>
  );
}
