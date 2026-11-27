import { Button, Checkbox, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  getNovelCategoryIds,
  listCategories,
  NovelCategoryError,
  setNovelCategories,
} from "../../db/queries/category";
import type { LibraryNovelCategory } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { describeError } from "../../lib/errors";
import { IconButton } from "../IconButton";
import { UserCategoryName, formatUserCategoryName } from "../UserCategoryName";
import { EditIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { StatusAlert } from "../ui/StatusAlert";

interface NovelCategoryEditorProps {
  active: boolean;
  initialCategories?: readonly LibraryNovelCategory[];
  novelId: number;
  novelName: string;
  onCloseSheet: () => void;
  onOpenSheet: () => void;
  sheetOpen: boolean;
  /** Renders only the sheet, for a caller that opens it from elsewhere (a toast action). */
  sheetOnly?: boolean;
}

/** Lists assigned categories and opens their shared editor. */
export function NovelCategoryEditor({
  active,
  initialCategories,
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
    queryFn: () => listCategories("committed"),
    staleTime: Infinity,
    enabled: active,
  });
  const membershipKey = ["category", "novel", novelId];
  const membershipQuery = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: membershipKey,
    queryFn: () => getNovelCategoryIds(novelId, "committed"),
    enabled: active,
  });
  const categories = (categoriesQuery.data ?? []).filter((category) => !category.isSystem);
  const assignedIds = membershipQuery.data;
  const assignedCategories = categoriesQuery.data && assignedIds
    ? categories.filter((category) => assignedIds.includes(category.id))
    : initialCategories ?? [];
  const save = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (ids: number[]) => setNovelCategories(novelId, ids),
    onSuccess: async (_data, ids) => {
      queryClient.setQueryData(membershipKey, ids);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["category"] }),
        queryClient.invalidateQueries({ queryKey: ["novel", "library"] }),
        queryClient.invalidateQueries({ queryKey: ["novel", "detail", novelId], exact: true }),
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
      {sheetOnly ? null : (
        <div className="norea-novel-categories">
          {assignedCategories.length > 0 ? (
            <ul className="norea-novel-category-names">
              {assignedCategories.map(category => (
                <li key={category.id}>
                  <span className="norea-user-category-name" title={category.name}>{formatUserCategoryName(category.name)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <IconButton aria-haspopup="dialog" label={t("categories.editWork")} onClick={onOpenSheet}>
            <EditIcon />
          </IconButton>
        </div>
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
          <Text fw="var(--norea-weight-bold)">{novelName}</Text>
          <Text c="dimmed" size="sm">{t("categories.editWorkDescription")}</Text>
          {errorMessage ? (
            <StatusAlert color="danger" role="alert">
              {errorMessage}
            </StatusAlert>
          ) : null}
          {queryError ? (
            <Button onClick={retry} size="compact-sm" variant="subtle">{t("common.retry")}</Button>
          ) : null}
          {loading ? <Loader size="sm" /> : null}
          {categories.map((category) => (
            <Checkbox
              checked={selectedIds.includes(category.id)}
              disabled={loading || !!queryError || save.isPending}
              key={category.id}
              label={<UserCategoryName name={category.name} />}
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
