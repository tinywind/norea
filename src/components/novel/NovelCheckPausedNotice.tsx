import { Button, Text } from "@mantine/core";
import { useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { getNovelFreshness } from "../../db/queries/novel-freshness";
import { formatDateForLocale, useTranslation } from "../../i18n";
import { CHECK_BACKOFF_FAILURES } from "../../lib/updates/check-cadence";
import { novelKey } from "./novel-detail-model";

interface NovelCheckPausedNoticeProps {
  /** A library novel with an installed source whose check is not running now. */
  active: boolean;
  /** The novel's "Check for new chapters". */
  checkNow: Pick<UseMutationResult<unknown, unknown, void>, "isPending" | "mutate">;
  novelId: number;
}

/** "Paused checking" with Check now, once a novel's checks back off after failing in a row. */
export function NovelCheckPausedNotice({ active, checkNow, novelId }: NovelCheckPausedNoticeProps) {
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const freshnessKey = [...novelKey(novelId), "freshness"] as const;
  const freshness = useQuery({
    queryKey: freshnessKey,
    queryFn: () => getNovelFreshness(novelId, "committed"),
    enabled: active,
  });
  if (!active || (freshness.data?.consecutiveFailures ?? 0) < CHECK_BACKOFF_FAILURES) return null;
  const lastSuccessAt = freshness.data?.lastSuccessAt ?? null;

  return (
    <div className="norea-novel-check-paused" role="status">
      <Text c="warn" size="sm">
        {lastSuccessAt
          ? t("novel.checkPaused", { date: formatDateForLocale(locale, lastSuccessAt * 1000) })
          : t("novel.checkPausedNeverSucceeded")}
      </Text>
      <Button
        loading={checkNow.isPending}
        onClick={() => checkNow.mutate(undefined, {
          onSettled: () => { void queryClient.invalidateQueries({ queryKey: freshnessKey }); },
        })}
        size="compact-sm"
        variant="default"
      >
        {t("updates.checkNow")}
      </Button>
    </div>
  );
}
