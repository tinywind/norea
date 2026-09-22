import { Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useState,
  type FormEvent,
} from "react";
import {
  deleteCategory,
  insertCategory,
  updateCategory,
  type LibraryCategory,
} from "../../db/queries/category";
import { useTranslation } from "../../i18n";
import { useLibraryStore } from "../../store/library";
import { TextButton } from "../TextButton";
type CategoryEditorState =
  | { mode: "create" }
  | { category: LibraryCategory; mode: "rename" };

export interface LibraryCategoryDialogsHandle {
  createCategory: () => void;
  renameCategory: (category: LibraryCategory) => void;
  deleteCategory: (category: LibraryCategory) => void;
}

export const LibraryCategoryDialogs = forwardRef<
  LibraryCategoryDialogsHandle,
  { active: boolean }
>(function LibraryCategoryDialogs({ active }, ref) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const selectedCategoryId = useLibraryStore(
    (state) => state.selectedCategoryId,
  );
  const setSelectedCategoryId = useLibraryStore(
    (state) => state.setSelectedCategoryId,
  );
  const invalidateLibraryCategories = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["category"] });
    void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
  }, [queryClient]);
  const [categoryEditor, setCategoryEditor] =
    useState<CategoryEditorState | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryDeleteTarget, setCategoryDeleteTarget] =
    useState<LibraryCategory | null>(null);
  const createCategoryMutation = useMutation({
    mutationFn: (name: string) => insertCategory({ name }),
    onSuccess: () => {
      invalidateLibraryCategories();
      setCategoryEditor(null);
      setCategoryName("");
    },
  });

  const renameCategoryMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      updateCategory(id, { name }),
    onSuccess: () => {
      invalidateLibraryCategories();
      setCategoryEditor(null);
      setCategoryName("");
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: (id: number) => deleteCategory(id),
    onSuccess: (_data, id) => {
      invalidateLibraryCategories();
      if (selectedCategoryId === id) {
        setSelectedCategoryId(null);
      }
      setCategoryDeleteTarget(null);
    },
  });

  const openCreateCategory = useCallback(() => {
    createCategoryMutation.reset();
    renameCategoryMutation.reset();
    setCategoryName("");
    setCategoryEditor({ mode: "create" });
  }, [createCategoryMutation, renameCategoryMutation]);

  const openRenameCategory = useCallback(
    (category: LibraryCategory) => {
      createCategoryMutation.reset();
      renameCategoryMutation.reset();
      setCategoryName(category.name);
      setCategoryEditor({ category, mode: "rename" });
    },
    [createCategoryMutation, renameCategoryMutation],
  );

  const closeCategoryEditor = useCallback(() => {
    createCategoryMutation.reset();
    renameCategoryMutation.reset();
    setCategoryEditor(null);
    setCategoryName("");
  }, [createCategoryMutation, renameCategoryMutation]);

  const handleCategorySubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!categoryEditor || categoryName.trim() === "") return;

      if (categoryEditor.mode === "create") {
        createCategoryMutation.mutate(categoryName);
      } else {
        renameCategoryMutation.mutate({
          id: categoryEditor.category.id,
          name: categoryName,
        });
      }
    },
    [
      categoryEditor,
      categoryName,
      createCategoryMutation,
      renameCategoryMutation,
    ],
  );

  const categoryEditorTitle =
    categoryEditor?.mode === "rename"
      ? t("categories.rename")
      : t("categories.add");
  const categoryMutationError =
    createCategoryMutation.error ?? renameCategoryMutation.error;
  const categorySaving =
    createCategoryMutation.isPending || renameCategoryMutation.isPending;

  useImperativeHandle(
    ref,
    () => ({
      createCategory: openCreateCategory,
      renameCategory: openRenameCategory,
      deleteCategory: setCategoryDeleteTarget,
    }),
    [openCreateCategory, openRenameCategory],
  );
  return (
    <>
      {" "}
      <Modal
        opened={active && categoryEditor !== null}
        onClose={closeCategoryEditor}
        title={categoryEditorTitle}
      >
        <form onSubmit={handleCategorySubmit}>
          <Stack gap="sm">
            <TextInput
              autoFocus
              label={t("library.categoryName")}
              onChange={(event) => setCategoryName(event.currentTarget.value)}
              value={categoryName}
            />
            {categoryMutationError ? (
              <Text c="red" size="sm">
                {categoryMutationError instanceof Error
                  ? categoryMutationError.message
                  : String(categoryMutationError)}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <TextButton
                type="button"
                variant="subtle"
                onClick={closeCategoryEditor}
              >
                {t("common.cancel")}
              </TextButton>
              <TextButton
                disabled={categoryName.trim() === ""}
                loading={categorySaving}
                type="submit"
              >
                {t("common.save")}
              </TextButton>
            </Group>
          </Stack>
        </form>
      </Modal>
      <Modal
        opened={active && categoryDeleteTarget !== null}
        onClose={() => {
          deleteCategoryMutation.reset();
          setCategoryDeleteTarget(null);
        }}
        title={t("categories.delete")}
      >
        <Stack gap="sm">
          <Text size="sm">
            {categoryDeleteTarget
              ? t("library.deleteCategory.message", {
                  name: categoryDeleteTarget.name,
                })
              : ""}
          </Text>
          {deleteCategoryMutation.error ? (
            <Text c="red" size="sm">
              {deleteCategoryMutation.error instanceof Error
                ? deleteCategoryMutation.error.message
                : String(deleteCategoryMutation.error)}
            </Text>
          ) : null}
          <Group justify="flex-end">
            <TextButton
              type="button"
              variant="subtle"
              onClick={() => {
                deleteCategoryMutation.reset();
                setCategoryDeleteTarget(null);
              }}
            >
              {t("common.cancel")}
            </TextButton>
            <TextButton
              loading={deleteCategoryMutation.isPending}
              tone="danger"
              onClick={() => {
                if (categoryDeleteTarget) {
                  deleteCategoryMutation.mutate(categoryDeleteTarget.id);
                }
              }}
            >
              {t("common.delete")}
            </TextButton>
          </Group>
        </Stack>
      </Modal>
    </>
  );
});
