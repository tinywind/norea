import { Alert, Checkbox, Drawer, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getNovelCategoryIds,
  listCategories,
  NovelCategoryError,
  setNovelCategories,
} from "../../db/queries/category";
import { useTranslation } from "../../i18n";
import { usePageBackNavigation } from "../../lib/android-back-navigation";
import { describeError } from "../../lib/errors";
import { ConsoleChip, ConsolePanel } from "../ConsolePrimitives";
import { TextButton } from "../TextButton";

interface NovelCategoryEditorProps {
  active: boolean;
  novelId: number;
  novelName: string;
}

export function NovelCategoryEditor({ active, novelId, novelName }: NovelCategoryEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const categoriesQuery = useQuery({
    queryKey: ["category", "list"],
    queryFn: listCategories,
    enabled: active,
  });
  const membershipKey = ["category", "novel", novelId];
  const membershipQuery = useQuery({
    queryKey: membershipKey,
    queryFn: () => getNovelCategoryIds(novelId),
    enabled: active,
  });
  const categories = (categoriesQuery.data ?? []).filter((category) => !category.isSystem);
  const assignedIds = membershipQuery.data ?? [];
  const assignedCategories = categories.filter((category) => assignedIds.includes(category.id));
  const save = useMutation({
    mutationFn: (ids: number[]) => setNovelCategories(novelId, ids),
    onSuccess: async (_data, ids) => {
      queryClient.setQueryData(membershipKey, ids);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["category"] }),
        queryClient.invalidateQueries({ queryKey: ["novel", "library"] }),
      ]);
      setOpened(false);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["category"] });
    },
  });
  const loading = categoriesQuery.isPending || membershipQuery.isPending;
  const queryError = categoriesQuery.error ?? membershipQuery.error;
  const error = save.error ?? queryError;
  const errorMessage = error instanceof NovelCategoryError
    ? t(error.code === "work-not-found" ? "categories.workNotFound" : "categories.selectionUnavailable")
    : error ? describeError(error) : null;
  const close = () => { if (!save.isPending) setOpened(false); };
  usePageBackNavigation(() => {
    if (!active || !opened) return false;
    close();
    return true;
  });

  return <>
    <ConsolePanel p="sm" style={{ flexShrink: 0 }}>
      <Group justify="space-between" gap="sm" wrap="wrap">
        <Group gap="xs" wrap="wrap" aria-label={t("categories.title")}>
          <Text size="sm" fw={600}>{t("categories.title")}</Text>
          {loading ? <Loader size="xs" /> : queryError ? null : assignedCategories.length > 0
            ? assignedCategories.map((category) => <ConsoleChip key={category.id}>{category.name}</ConsoleChip>)
            : <Text c="dimmed" size="sm">{t("categories.uncategorized")}</Text>}
        </Group>
        <TextButton size="sm" disabled={loading || !!queryError} onClick={() => {
          setSelectedIds([...assignedIds]);
          save.reset();
          setOpened(true);
        }}>{t("categories.editWork")}</TextButton>
      </Group>
      {queryError ? <Alert color="red" mt="sm">
        {describeError(queryError)}
        <TextButton size="sm" onClick={() => {
          void categoriesQuery.refetch();
          void membershipQuery.refetch();
        }}>{t("common.retry")}</TextButton>
      </Alert> : null}
    </ConsolePanel>
    <Drawer opened={active && opened} onClose={close} position="right" size="sm"
      closeOnClickOutside={!save.isPending} closeOnEscape={!save.isPending}
      withCloseButton={!save.isPending} title={t("categories.editWork")}>
      <Stack gap="md">
        <Text fw={600}>{novelName}</Text>
        <Text c="dimmed" size="sm">{t("categories.editWorkDescription")}</Text>
        {errorMessage ? <Alert color="red">{errorMessage}</Alert> : null}
        <ScrollArea.Autosize mah="calc(100dvh - 20rem)">
          <Stack gap="md">
            {categories.map((category) => <Checkbox key={category.id} label={category.name}
              checked={selectedIds.includes(category.id)} disabled={save.isPending}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelectedIds((current) => checked
                  ? [...current, category.id]
                  : current.filter((id) => id !== category.id));
              }} />)}
            {categories.length === 0 ? <Text c="dimmed" size="sm">{t("categories.noManual")}</Text> : null}
          </Stack>
        </ScrollArea.Autosize>
        <Group justify="space-between" gap="xs" wrap="wrap">
          <TextButton size="sm" disabled={save.isPending || selectedIds.length === 0}
            onClick={() => setSelectedIds([])}>{t("categories.clearWork")}</TextButton>
          <Group gap="xs">
            <TextButton size="sm" disabled={save.isPending} onClick={close}>{t("common.cancel")}</TextButton>
            <TextButton size="sm" tone="accent" loading={save.isPending}
              disabled={loading || !!queryError} onClick={() => save.mutate(selectedIds)}>{t("common.save")}</TextButton>
          </Group>
        </Group>
      </Stack>
    </Drawer>
  </>;
}
