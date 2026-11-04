import { Button } from "@mantine/core";
import { useCallback, useId, useState } from "react";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { describeError } from "../../lib/errors";
import { pluginManager } from "../../lib/plugins/manager";
import { openPluginSite } from "../../lib/plugins/open-plugin-site";
import { isCloudflareError } from "../browse/BrowseSearchTab";
import { useNovelMetadata } from "../novel/use-novel-metadata";
import {
  SourceAccessVerifyButton,
  useSourceAccessBlocks,
} from "../SourceAccessVerifyButton";

export type NovelEndCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "found"; count: number }
  | { status: "none" }
  | { status: "failed"; error: unknown };

const IDLE: NovelEndCheck = { status: "idle" };

/**
 * RD17: checks the novel's source for chapters after the last one, in place,
 * with the novel page's own refresh. The result belongs to one chapter and
 * resets when the reader moves to another.
 */
export function useNovelEndCheck({
  chapterId,
  countNewChapters,
  novel,
}: {
  chapterId: number;
  /** Re-reads the chapter list and counts chapters after the current one. */
  countNewChapters: () => Promise<number>;
  novel: NovelDetailRecord | null;
}) {
  const { refreshMetadata } = useNovelMetadata(novel?.id ?? 0, novel);
  const [result, setResult] = useState<{ chapterId: number; check: NovelEndCheck }>({
    chapterId,
    check: IDLE,
  });
  const check = result.chapterId === chapterId ? result.check : IDLE;
  const { mutateAsync } = refreshMetadata;

  const run = useCallback(async () => {
    setResult({ chapterId, check: { status: "checking" } });
    try {
      await mutateAsync();
      const count = await countNewChapters();
      setResult({
        chapterId,
        check: count > 0 ? { status: "found", count } : { status: "none" },
      });
    } catch (error) {
      setResult({ chapterId, check: { status: "failed", error } });
    }
  }, [chapterId, countNewChapters, mutateAsync]);

  return { check, run };
}

interface ReaderEndOfNovelProps {
  check: NovelEndCheck;
  novel: NovelDetailRecord | null;
  onBackToNovel: () => void;
  onCheck: () => void;
  onContinue: () => void;
}

function VerifyAction({ error, novel }: { error: unknown; novel: NovelDetailRecord }) {
  const { t } = useTranslation();
  const block = useSourceAccessBlocks(true)(novel.pluginId);
  const plugin = pluginManager.getPlugin(novel.pluginId);
  const sourceName = plugin?.name ?? novel.pluginName ?? novel.pluginId;
  if (block) {
    return (
      <SourceAccessVerifyButton
        block={block}
        label={t("updates.failure.verify")}
        sourceName={sourceName}
      />
    );
  }
  if (!plugin || !isCloudflareError(describeError(error))) return null;
  return (
    <Button
      onClick={() => openPluginSite(plugin, t("tasks.task.openSite", { source: sourceName }))}
      size="compact-sm"
      variant="default"
    >
      {t("updates.failure.verify")}
    </Button>
  );
}

/** The card shown at the bottom of the last chapter of a novel. */
export function ReaderEndOfNovel({
  check,
  novel,
  onBackToNovel,
  onCheck,
  onContinue,
}: ReaderEndOfNovelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const canCheck = Boolean(novel && !novel.isLocal);

  return (
    <section aria-labelledby={titleId} className="norea-reader-end-card">
      <h2 className="norea-reader-end-title" id={titleId}>
        {t("reader.end.title")}
      </h2>
      <p aria-live="polite" className="norea-reader-end-message">
        {check.status === "none"
          ? t("reader.end.none")
          : check.status === "failed"
            ? t("reader.end.failed")
            : check.status === "found"
              ? null
              : canCheck
                ? t("reader.end.message")
                : t("reader.end.localMessage")}
      </p>
      {check.status === "failed" ? (
        <details className="norea-state-details">
          <summary>{t("common.details")}</summary>
          {describeError(check.error)}
        </details>
      ) : null}
      <div className="norea-reader-end-actions">
        {check.status === "found" ? (
          <Button onClick={onContinue}>
            {t(check.count === 1 ? "reader.end.continueOne" : "reader.end.continue", {
              count: check.count,
            })}
          </Button>
        ) : check.status === "failed" && novel ? (
          <>
            <Button onClick={onCheck}>{t("common.retry")}</Button>
            <VerifyAction error={check.error} novel={novel} />
          </>
        ) : canCheck ? (
          <Button loading={check.status === "checking"} onClick={onCheck}>
            {t("reader.end.check")}
          </Button>
        ) : null}
        <Button onClick={onBackToNovel} variant="default">
          {t("reader.backToNovel")}
        </Button>
      </div>
    </section>
  );
}
