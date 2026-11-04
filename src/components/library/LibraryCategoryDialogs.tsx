import { Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  forwardRef,
  useCallback,
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
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { useLibraryStore } from "../../store/library";
import { TextButton } from "../TextButton";
import { getFocusReturnTarget } from "../ui/OverflowMenu";

// Category dialogs open from the Manage categories dialog too, so they sit above it.
const CATEGORY_DIALOG_Z_INDEX = "var(--norea-z-overlay-nested)";
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

  const deleteCategoryMutation = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (id: number) => deleteCategory(id),
    onSuccess: (_data, id) => {
      invalidateLibraryCategories();
      if (selectedCategoryId === id) {
        setSelectedCategoryId(null);
      }
      if (useLibraryStore.getState().defaultCategoryId === id) {
        useLibraryStore.getState().setDefaultCategoryId(null);
      }
      setCategoryDeleteTarget(null);
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
    (category: LibraryCategory) => {
      rememberFocusReturn();
      deleteCategoryMutation.reset();
      setCategoryDeleteTarget(category);
    },
    [deleteCategoryMutation, rememberFocusReturn],
  );
  const closeCategoryDelete = useCallback(() => {
    if (deleteCategoryMutation.isPending) return;
    deleteCategoryMutation.reset();
    setCategoryDeleteTarget(null);
  }, [deleteCategoryMutation]);
  useOverlayBackNavigation(active && categoryEditor !== null, closeCategoryEditor);
  useOverlayBackNavigation(active && categoryDeleteTarget !== null, closeCategoryDelete);

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
  const deleting = deleteCategoryMutation.isPending;

  useImperativeHandle(
    ref,
    () => ({
      createCategory: openCreateCategory,
      renameCategory: openRenameCategory,
      deleteCategory: openDeleteCategory,
    }),
    [openCreateCategory, openDeleteCategory, openRenameCategory],
  );
  return (
    <>
      {" "}
      <Modal
        closeOnClickOutside={!categorySaving}
        closeOnEscape={!categorySaving}
        onClose={closeCategoryEditor}
        onExitTransitionEnd={restoreFocus}
        opened={active && categoryEditor !== null}
        returnFocus={false}
        title={categoryEditorTitle}
        withCloseButton={!categorySaving}
        zIndex={CATEGORY_DIALOG_Z_INDEX}
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
              <Text c="danger" role="alert" size="sm">
                {categoryMutationError instanceof Error
                  ? categoryMutationError.message
                  : String(categoryMutationError)}
              </Text>
            ) : null}
            <Group justify="flex-end">
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
        closeOnClickOutside={!deleting}
        closeOnEscape={!deleting}
        onClose={closeCategoryDelete}
        onExitTransitionEnd={restoreFocus}
        opened={active && categoryDeleteTarget !== null}
        returnFocus={false}
        title={t("categories.delete")}
        withCloseButton={!deleting}
        zIndex={CATEGORY_DIALOG_Z_INDEX}
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
            <Text c="danger" role="alert" size="sm">
              {deleteCategoryMutation.error instanceof Error
                ? deleteCategoryMutation.error.message
                : String(deleteCategoryMutation.error)}
            </Text>
          ) : null}
          <Group justify="flex-end">
            <TextButton
              disabled={deleting}
              type="button"
              variant="subtle"
              onClick={closeCategoryDelete}
            >
              {t("common.cancel")}
            </TextButton>
            <TextButton
              loading={deleting}
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
