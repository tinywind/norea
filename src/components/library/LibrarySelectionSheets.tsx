import { Button, Checkbox, Group, Loader, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  countNovelsByCategory,
  type LibraryCategory,
} from "../../db/queries/category";
import { useTranslation } from "../../i18n";
import { IconButton } from "../IconButton";
import { PlusIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { DownloadOnceChoices } from "../DownloadOnceChoices";
import type { DownloadOnceSelection } from "./download-once";
import { describeError } from "../../lib/errors";

function sortedIds(novelIds: readonly number[]): number[] {
  return [...novelIds].sort((left, right) => left - right);
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
        <IconButton label={t("categories.add")} onClick={onCreateCategory} size="lg">
          <PlusIcon />
        </IconButton>
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

interface LibraryDownloadSheetProps {
  applying: boolean;
  error: unknown;
  novelCount: number;
  onChoose: (selection: DownloadOnceSelection) => void;
  onClose: () => void;
  opened: boolean;
}

/** Choosing a range queues it once for each selected source work. */
export function LibraryDownloadSheet({ applying, error, novelCount, onChoose, onClose, opened }: LibraryDownloadSheetProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveSheet onClose={onClose} opened={opened} title={t("library.downloadOnce.title")}>
      {opened ? <Stack gap="md">
        <Text size="sm">{t("downloadOnce.selectedWorks", { count: novelCount })}</Text>
        {error ? <Text c="danger" role="alert" size="sm">{describeError(error)}</Text> : null}
        <DownloadOnceChoices disabled={applying || novelCount === 0} onChoose={onChoose} onClose={onClose} />
      </Stack> : null}
    </ResponsiveSheet>
  );
}
