import { Text, UnstyledButton } from "@mantine/core";
import { useEffect, useRef } from "react";
import {
  UNCATEGORIZED_CATEGORY_ID,
  type LibraryCategory,
} from "../../db/queries/category";
import { useTranslation } from "../../i18n";
import { IconButton } from "../IconButton";
import { EditIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { OverflowMenu } from "../ui/OverflowMenu";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { type TranslateFn } from "./LibraryViewOptions";

export interface LibraryCategoryEntry {
  /** Set for a category the user can rename or delete. */
  category?: LibraryCategory;
  count: number;
  id: number | null;
  label: string;
}

/** All, then the user's categories, then Uncategorized, with novel counts. */
export function getLibraryCategoryEntries(
  categories: readonly LibraryCategory[],
  counts: { all: number; uncategorized: number },
  t: TranslateFn,
): LibraryCategoryEntry[] {
  return [
    { count: counts.all, id: null, label: t("categories.all") },
    ...categories
      .filter((category) => category.id !== UNCATEGORIZED_CATEGORY_ID)
      .map((category) => ({
        category: category.isSystem ? undefined : category,
        count: category.novelCount,
        id: category.id,
        label: category.name,
      })),
    {
      count: counts.uncategorized,
      id: UNCATEGORIZED_CATEGORY_ID,
      label: t("categories.uncategorized"),
    },
  ];
}

interface CategoryTabsProps {
  activeId: number | null;
  entries: readonly LibraryCategoryEntry[];
  onSelect: (id: number | null) => void;
}

/** Reveals a tab without moving the page or any other scroll container. */
function revealCategoryTab(strip: HTMLDivElement | null, tab: HTMLButtonElement | null): void {
  if (!strip || !tab || strip.clientWidth === 0) return;
  const left = strip.getBoundingClientRect().left + strip.clientLeft;
  const right = left + strip.clientWidth;
  const bounds = tab.getBoundingClientRect();
  const delta = bounds.left < left
    ? bounds.left - left
    : bounds.right > right ? bounds.right - right : 0;
  if (delta !== 0) strip.scrollBy({ left: delta });
}

/** Horizontally scrolling category switcher for phones and tablets. */
export function CategoryTabs({ activeId, entries, onSelect }: CategoryTabsProps) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);

  useEffect(() => {
    const strip = stripRef.current;
    const revealActive = () => revealCategoryTab(strip, activeRef.current);
    revealActive();
    if (!strip || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealActive);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activeId, activeIndex]);

  return (
    <div
      aria-label={t("categories.title")}
      className="norea-library-category-tabs"
      ref={stripRef}
      role="group"
    >
      {entries.map((entry) => {
        const active = entry.id === activeId;
        return (
          <UnstyledButton
            aria-pressed={active}
            className="norea-library-category-tab norea-state-layer"
            data-active={active}
            key={entry.id ?? "all"}
            onClick={() => onSelect(entry.id)}
            onFocus={(event) => revealCategoryTab(stripRef.current, event.currentTarget)}
            ref={active ? activeRef : undefined}
          >
            <span className="norea-library-category-tab-label">{entry.label}</span>
            <span className="norea-library-category-count">
              {entry.count.toLocaleString()}
            </span>
          </UnstyledButton>
        );
      })}
    </div>
  );
}

interface CategoryListProps {
  activeId: number | null;
  entries: readonly LibraryCategoryEntry[];
  error: unknown;
  loading: boolean;
  onCreate: () => void;
  onDelete: (category: LibraryCategory) => void;
  onRename: (category: LibraryCategory) => void;
  onSelect: (id: number | null) => void;
}

/**
 * Category rows with counts, a per-row overflow for rename and delete, and
 * "+ Category". Shared by the desktop panel and Manage categories.
 */
export function CategoryList({
  activeId,
  entries,
  error,
  loading,
  onCreate,
  onDelete,
  onRename,
  onSelect,
}: CategoryListProps) {
  const { t } = useTranslation();

  return (
    <div className="norea-library-category-list">
      <ul aria-label={t("categories.title")}>
        {entries.map((entry) => {
          const active = entry.id === activeId;
          const { category } = entry;
          return (
            <li
              className="norea-library-category-row"
              data-active={active}
              key={entry.id ?? "all"}
            >
              <UnstyledButton
                aria-current={active ? "true" : undefined}
                className="norea-library-category norea-state-layer"
                onClick={() => onSelect(entry.id)}
              >
                <span className="norea-library-category-label">{entry.label}</span>
                <span className="norea-library-category-count">
                  {entry.count.toLocaleString()}
                </span>
              </UnstyledButton>
              {category ? (
                <OverflowMenu
                  items={[
                    {
                      icon: EditIcon,
                      label: t("categories.rename"),
                      onClick: () => onRename(category),
                    },
                    {
                      danger: true,
                      icon: TrashIcon,
                      label: t("categories.delete"),
                      onClick: () => onDelete(category),
                    },
                  ]}
                  label={t("categories.actionsFor", { name: category.name })}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {loading ? (
        <Text c="dimmed" className="norea-library-category-note" size="sm">
          {t("common.loading")}
        </Text>
      ) : error ? (
        <Text c="danger" className="norea-library-category-note" role="alert" size="sm">
          {t("categories.loadFailed")}
        </Text>
      ) : null}
      <IconButton
        className="norea-library-category-add"
        label={t("categories.add")}
        onClick={onCreate}
        size="lg"
      >
        <PlusIcon />
      </IconButton>
    </div>
  );
}

interface CategoryManagerProps extends Omit<CategoryListProps, "onSelect"> {
  onClose: () => void;
  onSelect: (id: number | null) => void;
  opened: boolean;
}

/** Manage categories: a full-screen dialog on phones, a modal on wider screens. */
export function CategoryManager({
  onClose,
  onSelect,
  opened,
  ...listProps
}: CategoryManagerProps) {
  const { t } = useTranslation();

  return (
    <ResponsiveSheet
      onClose={onClose}
      opened={opened}
      title={t("library.manageCategories")}
    >
      <CategoryList
        {...listProps}
        onSelect={(id) => {
          onSelect(id);
          onClose();
        }}
      />
    </ResponsiveSheet>
  );
}
