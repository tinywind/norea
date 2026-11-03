import { useState } from "react";
import {
  Popover,
  SegmentedControl,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  UNCATEGORIZED_CATEGORY_ID,
  type LibraryCategory,
} from "../../db/queries/category";
import { PlusGlyph, TrashGlyph } from "../ActionGlyphs";
import { IconButton } from "../IconButton";
import { type TranslateFn } from "./LibraryViewOptions";
interface CategorySubpanelProps {
  activeId: number | null;
  allCount: number;
  categories: readonly LibraryCategory[];
  error: unknown;
  loading: boolean;
  onCreate: () => void;
  onDelete: (category: LibraryCategory) => void;
  onOpenDrawer: () => void;
  onRename: (category: LibraryCategory) => void;
  onSelect: (id: number | null) => void;
  t: TranslateFn;
  uncategorizedCount: number;
}

export function CategorySubpanel({
  activeId,
  allCount,
  categories,
  error,
  loading,
  onCreate,
  onDelete,
  onOpenDrawer,
  onRename,
  onSelect,
  t,
  uncategorizedCount,
}: CategorySubpanelProps) {
  return (
    <aside
      className="norea-library-subpanel"
      aria-label={t("categories.title")}
    >
      <div className="norea-library-subpanel-header">
        <Text className="norea-console-kicker">{t("categories.title")}</Text>
        <Tooltip label={t("categories.add")} openDelay={350} withArrow>
          <IconButton
            className="norea-library-subpanel-icon"
            label={t("categories.add")}
            onClick={onCreate}
            size="sm"
            title={t("categories.add")}
          >
            <PlusGlyph />
          </IconButton>
        </Tooltip>
      </div>
      <ScrollArea className="norea-library-category-scroll">
        <div className="norea-library-category-list">
          <CategoryButton
            active={activeId === null}
            count={allCount}
            label={t("categories.all")}
            onClick={() => onSelect(null)}
            t={t}
          />
          <CategoryButton
            active={activeId === UNCATEGORIZED_CATEGORY_ID}
            count={uncategorizedCount}
            label={t("categories.uncategorized")}
            onClick={() => onSelect(UNCATEGORIZED_CATEGORY_ID)}
            t={t}
          />
          {loading ? (
            <Text className="norea-library-subpanel-note">
              {t("common.loading")}
            </Text>
          ) : error ? (
            <Text className="norea-library-subpanel-note" c="danger">
              {error instanceof Error ? error.message : String(error)}
            </Text>
          ) : categories.length > 0 ? (
            categories.map((category) => (
              <CategoryButton
                key={category.id}
                active={activeId === category.id}
                canEdit={!category.isSystem}
                count={category.novelCount}
                label={category.name}
                onDelete={() => onDelete(category)}
                onRename={() => onRename(category)}
                onClick={() => onSelect(category.id)}
                t={t}
              />
            ))
          ) : (
            <Text className="norea-library-subpanel-note">
              {t("categories.noManual")}
            </Text>
          )}
        </div>
      </ScrollArea>
      <div className="norea-library-subpanel-footer">
        <UnstyledButton onClick={onOpenDrawer}>
          {t("library.manageCategories")}
        </UnstyledButton>
      </div>
    </aside>
  );
}

interface CategoryButtonProps {
  active: boolean;
  canEdit?: boolean;
  count?: number;
  label: string;
  onDelete?: () => void;
  onRename?: () => void;
  onClick: () => void;
  t: TranslateFn;
}

function CategoryButton({
  active,
  canEdit = false,
  count,
  label,
  onDelete,
  onRename,
  onClick,
  t,
}: CategoryButtonProps) {
  return (
    <div className="norea-library-category-row" data-active={active}>
      <UnstyledButton
        className="norea-library-category norea-state-layer"
        data-active={active}
        aria-pressed={active}
        onClick={onClick}
      >
        <span className="norea-library-category-label">{label}</span>
      </UnstyledButton>
      {canEdit ? (
        <span className="norea-library-category-actions">
          <Tooltip label={t("categories.rename")} openDelay={350} withArrow>
            <IconButton
              className="norea-library-category-action"
              label={t("categories.renameNamed", { name: label })}
              onClick={onRename}
              size="sm"
              title={t("categories.rename")}
            >
              <EditIcon />
            </IconButton>
          </Tooltip>
          <Tooltip label={t("categories.delete")} openDelay={350} withArrow>
            <IconButton
              className="norea-library-category-action"
              label={t("categories.deleteNamed", { name: label })}
              onClick={onDelete}
              size="sm"
              title={t("categories.delete")}
            >
              <TrashGlyph />
            </IconButton>
          </Tooltip>
        </span>
      ) : null}
      <span className="norea-library-category-count">{count ?? 0}</span>
    </div>
  );
}

interface SelectionCategoryPickerProps {
  assigning: boolean;
  categories: readonly LibraryCategory[];
  onAssign: (categoryId: number, mode: "add" | "remove") => void;
  t: TranslateFn;
}

export function SelectionCategoryPicker({
  assigning,
  categories,
  onAssign,
  t,
}: SelectionCategoryPickerProps) {
  const [mode, setMode] = useState<"add" | "remove">("add");
  return (
    <Popover position="bottom-end" shadow="md" width={280}>
      <Popover.Target>
        <IconButton
          className="norea-library-selection-icon norea-state-layer"
          disabled={categories.length === 0 || assigning}
          label={t("library.editSelectedCategories")}
          size="sm"
          title={t("library.editSelectedCategories")}
        >
          <FolderPlusIcon />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="norea-library-category-assign-popover">
        <SegmentedControl
          fullWidth
          size="xs"
          aria-label={t("library.editSelectedCategories")}
          value={mode}
          onChange={(value) => setMode(value as "add" | "remove")}
          data={[
            { value: "add", label: t("library.categoryAction.add") },
            { value: "remove", label: t("library.categoryAction.remove") },
          ]}
        />
        <Text c="dimmed" size="xs" p="xs">
          {t("library.categoryAction.hint")}
        </Text>
        <div className="norea-library-category-assign-list">
          {categories.length > 0 ? (
            categories.map((category) => (
              <UnstyledButton
                className="norea-library-category-assign-option"
                disabled={assigning}
                key={category.id}
                onClick={() => onAssign(category.id, mode)}
              >
                <span>{category.name}</span>
              </UnstyledButton>
            ))
          ) : (
            <Text c="dimmed" size="sm">
              {t("library.addCategoryFirst")}
            </Text>
          )}
        </div>
      </Popover.Dropdown>
    </Popover>
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

function FolderPlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 6h6l2 2h8v10H4z" />
      <path d="M12 13h6" />
      <path d="M15 10v6" />
    </svg>
  );
}
