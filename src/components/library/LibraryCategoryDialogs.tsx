import { Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
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
import { useConfirm } from "../ui/ConfirmDialog";
import { getFocusReturnTarget } from "../ui/OverflowMenu";
import { ResponsiveSheet, SheetActions } from "../ui/ResponsiveSheet";

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
  const confirm = useConfirm();
  const formId = useId();
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const rememberFocusReturn = useCallback(() => {
    focusReturnRef.current = getFocusReturnTarget(document.activeElement);
  }, []);
  const restoreFocus = useCallback(() => {
    const target = focusReturnRef.current;
    focusReturnRef.current = null;
    if (target?.isConnected) target.focus();
  }, []);
  const createCategoryMutation = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (name: string) => insertCategory({ name }),
    onSuccess: () => {
      invalidateLibraryCategories();
      setCategoryEditor(null);
      setCategoryName("");
    },
  });

  const renameCategoryMutation = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      updateCategory(id, { name }),
    onSuccess: () => {
      invalidateLibraryCategories();
      setCategoryEditor(null);
      setCategoryName("");
    },
  });

  // The confirmation closes before the delete runs, so a failure surfaces as a toast.
  const deleteCategoryMutation = useMutation({
    meta: { errorPresentation: "toast" },
    mutationFn: (id: number) => deleteCategory(id),
    onSuccess: (_data, id) => {
      invalidateLibraryCategories();
      if (selectedCategoryId === id) {
        setSelectedCategoryId(null);
      }
      if (useLibraryStore.getState().defaultCategoryId === id) {
        useLibraryStore.getState().setDefaultCategoryId(null);
      }
    },
  });

  const openCreateCategory = useCallback(() => {
    rememberFocusReturn();
    createCategoryMutation.reset();
    renameCategoryMutation.reset();
    setCategoryName("");
    setCategoryEditor({ mode: "create" });
  }, [createCategoryMutation, rememberFocusReturn, renameCategoryMutation]);

  const openRenameCategory = useCallback(
    (category: LibraryCategory) => {
      rememberFocusReturn();
      createCategoryMutation.reset();
      renameCategoryMutation.reset();
      setCategoryName(category.name);
      setCategoryEditor({ category, mode: "rename" });
    },
    [createCategoryMutation, rememberFocusReturn, renameCategoryMutation],
  );

  const categorySaving =
    createCategoryMutation.isPending || renameCategoryMutation.isPending;
  const closeCategoryEditor = useCallback(() => {
    if (categorySaving) return;
    createCategoryMutation.reset();
    renameCategoryMutation.reset();
    setCategoryEditor(null);
    setCategoryName("");
  }, [categorySaving, createCategoryMutation, renameCategoryMutation]);

  const openDeleteCategory = useCallback(
    async (category: LibraryCategory) => {
      rememberFocusReturn();
      const confirmed = await confirm({
        title: t("categories.delete"),
        message: t("library.deleteCategory.message", { name: category.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      });
      restoreFocus();
      if (confirmed) deleteCategoryMutation.mutate(category.id);
    },
    [confirm, deleteCategoryMutation, rememberFocusReturn, restoreFocus, t],
  );

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

  useImperativeHandle(
    ref,
    () => ({
      createCategory: openCreateCategory,
      renameCategory: openRenameCategory,
      deleteCategory: (category) => void openDeleteCategory(category),
    }),
    [openCreateCategory, openDeleteCategory, openRenameCategory],
  );
  return (
    <ResponsiveSheet
      busy={categorySaving}
      footer={
        <SheetActions>
          <TextButton
            disabled={categorySaving}
            type="button"
            variant="subtle"
            onClick={closeCategoryEditor}
          >
            {t("common.cancel")}
          </TextButton>
          <TextButton
            disabled={categoryName.trim() === ""}
            form={formId}
            loading={categorySaving}
            type="submit"
          >
            {t("common.save")}
          </TextButton>
        </SheetActions>
      }
      // Category dialogs open from the Manage categories dialog too, so they sit above it.
      nested
      onClose={closeCategoryEditor}
      onExitTransitionEnd={restoreFocus}
      opened={active && categoryEditor !== null}
      returnFocus={false}
      title={categoryEditorTitle}
    >
      <form id={formId} onSubmit={handleCategorySubmit}>
        <Stack gap="sm">
          <TextInput
            autoFocus
            label={t("library.categoryName")}
            onChange={(event) => setCategoryName(event.currentTarget.value)}
            value={categoryName}
          />
          {categoryMutationError ? (
            <Text c="danger" role="alert" size="sm">
              {categoryMutationError instanceof Error
                ? categoryMutationError.message
                : String(categoryMutationError)}
            </Text>
          ) : null}
        </Stack>
      </form>
    </ResponsiveSheet>
  );
});
