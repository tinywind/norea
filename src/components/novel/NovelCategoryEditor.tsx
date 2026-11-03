import { Alert, Button, Checkbox, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  getNovelCategoryIds,
  listCategories,
  NovelCategoryError,
  setNovelCategories,
} from "../../db/queries/category";
import { useTranslation } from "../../i18n";
import { describeError } from "../../lib/errors";
import { PlusIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

interface NovelCategoryEditorProps {
  active: boolean;
  novelId: number;
  novelName: string;
  onCloseSheet: () => void;
  onOpenSheet: () => void;
  sheetOpen: boolean;
  /** Renders only the sheet, for a caller that opens it from elsewhere (a toast action). */
  sheetOnly?: boolean;
}

/**
 * The novel's categories as chips under its title. Any chip, or "+ Category"
 * when none is assigned, opens the sheet that edits the assignment.
 */
export function NovelCategoryEditor({
  active,
  novelId,
  novelName,
  onCloseSheet,
  onOpenSheet,
  sheetOpen,
  sheetOnly = false,
}: NovelCategoryEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const seededRef = useRef(false);
  const categoriesQuery = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["category", "list"],
    queryFn: () => listCategories(),
    enabled: active,
  });
  const membershipKey = ["category", "novel", novelId];
  const membershipQuery = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: membershipKey,
    queryFn: () => getNovelCategoryIds(novelId),
    enabled: active,
  });
  const categories = (categoriesQuery.data ?? []).filter((category) => !category.isSystem);
  const assignedIds = membershipQuery.data;
  const assignedCategories = categories.filter((category) => assignedIds?.includes(category.id));
  const save = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (ids: number[]) => setNovelCategories(novelId, ids),
    onSuccess: async (_data, ids) => {
      queryClient.setQueryData(membershipKey, ids);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["category"] }),
        queryClient.invalidateQueries({ queryKey: ["novel", "library"] }),
      ]);
      onCloseSheet();
      notifications.show({ color: "ok", message: t("categories.workSaved") });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["category"] });
    },
  });
  const opened = active && sheetOpen;
  const resetSave = save.reset;

  useEffect(() => {
    if (!opened) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current || !assignedIds) return;
    seededRef.current = true;
    setSelectedIds([...assignedIds]);
    resetSave();
  }, [assignedIds, opened, resetSave]);

  const loading = categoriesQuery.isPending || membershipQuery.isPending;
  const queryError = categoriesQuery.error ?? membershipQuery.error;
  const error = save.error ?? queryError;
  const errorMessage = error instanceof NovelCategoryError
    ? t(error.code === "work-not-found" ? "categories.workNotFound" : "categories.selectionUnavailable")
    : error ? describeError(error) : null;
  const close = () => {
    if (!save.isPending) onCloseSheet();
  };
  const retry = () => {
    void categoriesQuery.refetch();
    void membershipQuery.refetch();
  };

  return (
    <>
      {sheetOnly ? null : queryError ? (
        <Group className="norea-novel-categories" gap="xs">
          <Text c="danger" role="alert" size="sm">
            {t("categories.loadFailed")}
          </Text>
          <Button onClick={retry} size="compact-sm" variant="subtle">
            {t("common.retry")}
          </Button>
        </Group>
      ) : loading ? null : (
        <ul aria-label={t("categories.title")} className="norea-novel-categories">
          {assignedCategories.length > 0 ? (
            assignedCategories.map((category) => (
              <li key={category.id}>
                <button
                  aria-haspopup="dialog"
                  className="norea-novel-category-chip norea-state-layer"
                  onClick={onOpenSheet}
                  type="button"
                >
                  {category.name}
                </button>
              </li>
            ))
          ) : (
            <li>
              <button
                aria-haspopup="dialog"
                className="norea-novel-category-chip norea-state-layer"
                data-empty="true"
                onClick={onOpenSheet}
                type="button"
              >
                <PlusIcon size="1rem" />
                {t("categories.addToWork")}
              </button>
            </li>
          )}
        </ul>
      )}
      <ResponsiveSheet
        className="norea-novel-category-sheet"
        footer={
          <Group gap="xs" justify="space-between" wrap="wrap">
            <Button
              disabled={save.isPending || selectedIds.length === 0}
              onClick={() => setSelectedIds([])}
              variant="subtle"
            >
              {t("categories.clearWork")}
            </Button>
            <Group gap="xs">
              <Button disabled={save.isPending} onClick={close} variant="default">
                {t("common.cancel")}
              </Button>
              <Button
                disabled={loading || !!queryError}
                loading={save.isPending}
                onClick={() => save.mutate(selectedIds)}
              >
                {t("common.apply")}
              </Button>
            </Group>
          </Group>
        }
        onClose={close}
        opened={opened}
        title={t("categories.editWork")}
      >
        <Stack gap="md">
          <Text fw={600}>{novelName}</Text>
          <Text c="dimmed" size="sm">{t("categories.editWorkDescription")}</Text>
          {errorMessage ? (
            <Alert color="danger" role="alert">
              {errorMessage}
            </Alert>
          ) : null}
          {loading ? <Loader size="sm" /> : null}
          {categories.map((category) => (
            <Checkbox
              checked={selectedIds.includes(category.id)}
              disabled={save.isPending}
              key={category.id}
              label={category.name}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelectedIds((current) => checked
                  ? [...current, category.id]
                  : current.filter((id) => id !== category.id));
              }}
            />
          ))}
          {!loading && categories.length === 0 ? (
            <Text c="dimmed" size="sm">{t("categories.noManual")}</Text>
          ) : null}
        </Stack>
      </ResponsiveSheet>
    </>
  );
}
