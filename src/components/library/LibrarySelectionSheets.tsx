import { Button, Checkbox, Group, Loader, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  countNovelsByCategory,
  type LibraryCategory,
} from "../../db/queries/category";
import {
  listNovelDownloadGoals,
  type NovelDownloadGoal,
  type StoredNovelDownloadGoal,
} from "../../db/queries/novel-download-goal";
import { useTranslation } from "../../i18n";
import { DownloadGoalChoices, DownloadGoalSpacer, sameDownloadGoal } from "../DownloadGoalChoices";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";
import { PlusIcon } from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

function sortedIds(novelIds: readonly number[]): number[] {
  return [...novelIds].sort((left, right) => left - right);
}

/** The own goal every novel shares, null when none has one, undefined when they differ. */
export function sharedDownloadGoal(
  novelIds: readonly number[],
  goals: readonly StoredNovelDownloadGoal[],
): NovelDownloadGoal | null | undefined {
  const byNovel = new Map(goals.map((row) => [row.novelId, row.goal]));
  let shared: NovelDownloadGoal | null | undefined;
  for (const [index, novelId] of novelIds.entries()) {
    const goal = byNovel.get(novelId) ?? null;
    if (index === 0) shared = goal;
    else if (!sameDownloadGoal(goal, shared ?? null)) return undefined;
  }
  return shared;
}

interface LibraryDownloadGoalSheetProps {
  applying: boolean;
  novelIds: readonly number[];
  onApply: (goal: NovelDownloadGoal | null) => void;
  onClose: () => void;
  /** Queues every chapter not downloaded yet one time, without changing the goal. */
  onDownloadOnce: () => void;
  opened: boolean;
}

/** The download goal choices for the selected novels, the goal they share marked, and a one-time download. */
export function LibraryDownloadGoalSheet({
  applying,
  novelIds,
  onApply,
  onClose,
  onDownloadOnce,
  opened,
}: LibraryDownloadGoalSheetProps) {
  const { t } = useTranslation();
  const goals = useQuery({ enabled: opened, queryKey: DOWNLOAD_GOALS_QUERY_KEY, queryFn: listNovelDownloadGoals });
  const current = goals.data ? sharedDownloadGoal(novelIds, goals.data) : undefined;

  return (
    <ResponsiveSheet
      onClose={onClose}
      opened={opened}
      title={t("library.downloadGoal.title", { count: novelIds.length })}
    >
      <DownloadGoalChoices
        allRemainingDescription={t("downloadGoals.kind.allRemaining.many")}
        current={current}
        disabled={applying || novelIds.length === 0}
        entireDescription={t("downloadGoals.kind.entire.many")}
        onChoose={(goal) => {
          if (current !== undefined && sameDownloadGoal(goal, current)) onClose();
          else onApply(goal);
        }}
        pending={applying}
      >
        <ListRow
          disabled={applying || novelIds.length === 0}
          leading={<DownloadGoalSpacer />}
          onClick={onDownloadOnce}
          subtitle={t("library.downloadOnce.description")}
          title={t("library.downloadOnce.title")}
        />
      </DownloadGoalChoices>
    </ResponsiveSheet>
  );
}

export type CategoryMembership = "all" | "some" | "none";

/** Cycles a row through the states it can reach: some only when it started there. */
export function nextCategoryMembership(
  original: CategoryMembership,
  current: CategoryMembership,
): CategoryMembership {
  const cycle: CategoryMembership[] =
    original === "some" ? ["some", "all", "none"] : ["none", "all"];
  return cycle[(cycle.indexOf(current) + 1) % cycle.length]!;
}

interface LibraryCategorySheetProps {
  applying: boolean;
  categories: readonly LibraryCategory[];
  novelIds: readonly number[];
  onApply: (change: { add: number[]; remove: number[] }) => void;
  onClose: () => void;
  onCreateCategory: () => void;
  opened: boolean;
}

/**
 * Shows whether all, some or none of the selection is in each category and
 * applies the chosen additions and removals together.
 */
export function LibraryCategorySheet({
  applying,
  categories,
  novelIds,
  onApply,
  onClose,
  onCreateCategory,
  opened,
}: LibraryCategorySheetProps) {
  const { t } = useTranslation();
  const total = novelIds.length;
  const membership = useQuery({
    enabled: opened && total > 0,
    queryKey: ["category", "membership", sortedIds(novelIds)],
    queryFn: () => countNovelsByCategory(novelIds),
  });
  const [targets, setTargets] = useState<ReadonlyMap<number, CategoryMembership>>(
    () => new Map(),
  );
  useEffect(() => {
    if (opened) setTargets(new Map());
  }, [opened]);

  const rows = useMemo(
    () =>
      categories.map((category) => {
        const count = membership.data?.get(category.id) ?? 0;
        const original: CategoryMembership =
          count === 0 ? "none" : count >= total ? "all" : "some";
        return {
          category,
          count,
          current: targets.get(category.id) ?? original,
          original,
        };
      }),
    [categories, membership.data, targets, total],
  );
  const change = {
    add: rows.filter((row) => row.current !== row.original && row.current === "all")
      .map((row) => row.category.id),
    remove: rows.filter((row) => row.current !== row.original && row.current === "none")
      .map((row) => row.category.id),
  };
  const changed = change.add.length + change.remove.length > 0;

  return (
    <ResponsiveSheet
      className="norea-library-category-sheet"
      footer={
        <Group justify="flex-end" gap="xs">
          <Button onClick={onClose} variant="default">
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!changed || membership.isLoading}
            loading={applying}
            onClick={() => onApply(change)}
          >
            {t("common.apply")}
          </Button>
        </Group>
      }
      onClose={onClose}
      opened={opened}
      title={t("library.categoryAction.title", { count: total })}
    >
      <Stack gap="md">
        <Text c="dimmed" size="sm">
          {t("library.categoryAction.hint")}
        </Text>
        {membership.isLoading ? <Loader size="sm" /> : null}
        {membership.isError ? (
          <Text c="danger" role="alert" size="sm">
            {t("library.categoryAction.loadFailed")}
          </Text>
        ) : null}
        {categories.length === 0 ? (
          <Text size="sm">{t("library.addCategoryFirst")}</Text>
        ) : (
          rows.map((row) => (
            <Checkbox
              checked={row.current === "all"}
              description={getMembershipDescription(row, total, t)}
              disabled={applying || membership.isLoading}
              indeterminate={row.current === "some"}
              key={row.category.id}
              label={row.category.name}
              onChange={() =>
                setTargets((current) => {
                  const next = new Map(current);
                  const state = nextCategoryMembership(row.original, row.current);
                  if (state === row.original) next.delete(row.category.id);
                  else next.set(row.category.id, state);
                  return next;
                })
              }
            />
          ))
        )}
        <Button
          justify="flex-start"
          leftSection={<PlusIcon size="1.125rem" />}
          onClick={onCreateCategory}
          variant="subtle"
        >
          {t("categories.addShort")}
        </Button>
      </Stack>
    </ResponsiveSheet>
  );
}

function getMembershipDescription(
  row: { count: number; current: CategoryMembership; original: CategoryMembership },
  total: number,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (row.current !== row.original) {
    return row.current === "all"
      ? t("library.categoryAction.willAdd", { count: total - row.count })
      : t("library.categoryAction.willRemove", { count: row.count });
  }
  if (row.original === "all") return t("library.categoryAction.inAll", { count: total });
  if (row.original === "some") {
    return t("library.categoryAction.inSome", { count: row.count, total });
  }
  return t("library.categoryAction.inNone");
}
