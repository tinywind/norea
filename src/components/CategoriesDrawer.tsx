import { Drawer, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import {
  UNCATEGORIZED_CATEGORY_ID,
  type LibraryCategory,
} from "../db/queries/category";
import { IconButton } from "./IconButton";
import { useTranslation } from "../i18n";

interface CategoriesDrawerProps {
  allCount: number;
  categories: readonly LibraryCategory[];
  error: unknown;
  loading: boolean;
  onCreate: () => void;
  onDelete: (category: LibraryCategory) => void;
  opened: boolean;
  onClose: () => void;
  onRename: (category: LibraryCategory) => void;
  selectedCategoryId: number | null;
  onSelect: (id: number | null) => void;
  uncategorizedCount: number;
}

export function CategoriesDrawer({
  allCount,
  categories,
  error,
  loading,
  onCreate,
  onDelete,
  opened,
  onClose,
  onRename,
  selectedCategoryId,
  onSelect,
  uncategorizedCount,
}: CategoriesDrawerProps) {
  const { t } = useTranslation();

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={t("categories.title")}
      position="left"
      size="xs"
    >
      <Stack gap={8}>
        <UnstyledButton
          className="norea-library-drawer-add"
          onClick={() => {
            onCreate();
            onClose();
          }}
        >
          <PlusIcon />
          <span>{t("categories.add")}</span>
        </UnstyledButton>
        <ScrollArea.Autosize mah="calc(100vh - 9.375rem)">
          <Stack gap={2}>
            <DrawerCategoryButton
              active={selectedCategoryId === null}
              count={allCount}
              label={t("categories.all")}
              onClick={() => {
                onSelect(null);
                onClose();
              }}
            />
            <DrawerCategoryButton
              active={selectedCategoryId === UNCATEGORIZED_CATEGORY_ID}
              count={uncategorizedCount}
              label={t("categories.uncategorized")}
              onClick={() => {
                onSelect(UNCATEGORIZED_CATEGORY_ID);
                onClose();
              }}
            />
            {loading ? (
              <Text c="dimmed" size="sm" px="md" py="xs">
                {t("common.loading")}
              </Text>
            ) : error ? (
              <Text c="red" size="sm" px="md" py="xs">
                {error instanceof Error ? error.message : String(error)}
              </Text>
            ) : categories.length > 0 ? (
              categories.map((category) => (
                <DrawerCategoryButton
                  key={category.id}
                  active={selectedCategoryId === category.id}
                  label={category.name}
                  canEdit={!category.isSystem}
                  count={category.novelCount}
                  onClick={() => {
                    onSelect(category.id);
                    onClose();
                  }}
                  onDelete={() => {
                    onDelete(category);
                    onClose();
                  }}
                  onRename={() => {
                    onRename(category);
                    onClose();
                  }}
                />
              ))
            ) : (
              <Text c="dimmed" size="sm" px="md" py="xs">
                {t("categories.noManual")}
              </Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
      </Stack>
    </Drawer>
  );
}

interface DrawerCategoryButtonProps {
  active: boolean;
  canEdit?: boolean;
  count?: number;
  label: string;
  onClick: () => void;
  onDelete?: () => void;
  onRename?: () => void;
}

function DrawerCategoryButton({
  active,
  canEdit = false,
  count,
  label,
  onClick,
  onDelete,
  onRename,
}: DrawerCategoryButtonProps) {
  const { t } = useTranslation();

  return (
    <div className="norea-library-drawer-category-row" data-active={active}>
      <UnstyledButton
        className="norea-library-drawer-category"
        onClick={onClick}
      >
        <span>{label}</span>
      </UnstyledButton>
      {canEdit ? (
        <span className="norea-library-category-actions">
          <IconButton
            className="norea-library-category-action"
            label={t("categories.renameNamed", { name: label })}
            onClick={onRename}
            size="sm"
            title={t("categories.rename")}
          >
            <EditIcon />
          </IconButton>
          <IconButton
            className="norea-library-category-action"
            label={t("categories.deleteNamed", { name: label })}
            onClick={onDelete}
            size="sm"
            title={t("categories.delete")}
          >
            <TrashIcon />
          </IconButton>
        </span>
      ) : null}
      <span className="norea-library-category-count">{count ?? 0}</span>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 20h4" />
      <path d="M14 5l5 5" />
      <path d="M17 3l4 4L9 19H5v-4z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 14h10l1-14" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}
