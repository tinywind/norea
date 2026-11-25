import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Text, UnstyledButton } from "@mantine/core";
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  UNCATEGORIZED_CATEGORY_ID,
  type LibraryCategory,
} from "../../db/queries/category";
import { useTranslation } from "../../i18n";
import { IconButton } from "../IconButton";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DragIcon,
  EditIcon,
  PlusIcon,
  TrashIcon,
} from "../ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "../ui/OverflowMenu";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { type TranslateFn } from "./LibraryViewOptions";

const CATEGORY_DND_PREFIX = "category:";

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

export function categoryDndId(categoryId: number): string {
  return `${CATEGORY_DND_PREFIX}${categoryId}`;
}

export function parseCategoryDndId(id: unknown): number | null {
  const value = String(id);
  if (!value.startsWith(CATEGORY_DND_PREFIX)) return null;
  const categoryId = Number(value.slice(CATEGORY_DND_PREFIX.length));
  return Number.isInteger(categoryId) && categoryId > 0 ? categoryId : null;
}

/** Reorders manual category ids when moving `activeId` onto `overId`, or returns `null` if unchanged. */
export function reorderCategoryIds(
  orderedIds: readonly number[],
  activeId: number,
  overId: number,
): number[] | null {
  const oldIndex = orderedIds.indexOf(activeId);
  const newIndex = orderedIds.indexOf(overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return null;
  return arrayMove([...orderedIds], oldIndex, newIndex);
}

/** Optimistically applies a new manual category order while keeping system categories ahead of manual ones. */
export function applyCategoryOrder(
  categories: readonly LibraryCategory[],
  orderedIds: readonly number[],
): LibraryCategory[] {
  const manualCategories = categories.filter((category) => !category.isSystem);
  if (
    manualCategories.length !== orderedIds.length ||
    new Set(orderedIds).size !== orderedIds.length
  ) {
    return [...categories];
  }
  const manualIndexById = new Map(
    orderedIds.map((id, index) => [id, index] as const),
  );
  if (manualCategories.some((category) => !manualIndexById.has(category.id))) {
    return [...categories];
  }
  let maxSystemSort: number | null = null;
  for (const category of categories) {
    if (category.isSystem) {
      maxSystemSort =
        maxSystemSort === null
          ? category.sort
          : Math.max(maxSystemSort, category.sort);
    }
  }
  const baseSort = maxSystemSort === null ? 0 : maxSystemSort + 1;
  return categories
    .map((category) =>
      category.isSystem
        ? category
        : { ...category, sort: baseSort + manualIndexById.get(category.id)! },
    )
    .sort(
      (left, right) =>
        left.sort - right.sort || left.name.localeCompare(right.name),
    );
}

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

const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const WHEEL_LINE_PIXELS = 16;
const MOUSE_DRAG_THRESHOLD_PX = 6;

interface HorizontalMouseDragState {
  moved: boolean;
  pointerId: number;
  startScrollLeft: number;
  startX: number;
}

function useHorizontalMouseDrag(stripRef: RefObject<HTMLDivElement | null>) {
  const dragRef = useRef<HorizontalMouseDragState | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSuppressClick = () => {
    if (suppressClickTimerRef.current !== null) {
      clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
    suppressClickRef.current = false;
  };

  const stopDragging = (strip: HTMLDivElement | null, suppressClick: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (strip) {
      if (drag.moved && strip.hasPointerCapture?.(drag.pointerId)) {
        try {
          strip.releasePointerCapture(drag.pointerId);
        } catch {
          // Ignore browsers that already released capture.
        }
      }
      if (strip.dataset) delete strip.dataset.dragging;
    }
    if (suppressClick && drag.moved) {
      clearSuppressClick();
      suppressClickRef.current = true;
      suppressClickTimerRef.current = setTimeout(() => {
        suppressClickTimerRef.current = null;
        suppressClickRef.current = false;
      }, 0);
    }
  };

  useEffect(() => clearSuppressClick, []);

  return {
    onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!suppressClickRef.current) return;
      clearSuppressClick();
      event.preventDefault();
      event.stopPropagation();
    },
    onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
      const strip = stripRef.current;
      if (strip && strip.scrollWidth > strip.clientWidth) {
        event.preventDefault();
      }
    },
    onLostPointerCapture: () => {
      stopDragging(stripRef.current, false);
    },
    onPointerCancel: () => {
      stopDragging(stripRef.current, false);
    },
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      clearSuppressClick();
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const strip = stripRef.current;
      if (!strip || !(strip.scrollWidth > strip.clientWidth)) return;
      dragRef.current = {
        moved: false,
        pointerId: event.pointerId,
        startScrollLeft: strip.scrollLeft,
        startX: event.clientX,
      };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const strip = stripRef.current;
      if (!strip) return;
      if ((event.buttons & 1) === 0) {
        stopDragging(strip, false);
        return;
      }
      const deltaX = event.clientX - drag.startX;
      if (!drag.moved) {
        if (Math.abs(deltaX) < MOUSE_DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        if (strip.dataset) strip.dataset.dragging = "true";
        try {
          strip.setPointerCapture?.(event.pointerId);
        } catch {
          // Synthetic pointer events in tests or detached nodes may reject capture.
        }
      }
      strip.scrollLeft = drag.startScrollLeft - deltaX;
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      stopDragging(stripRef.current, true);
    },
  };
}

function normalizeCategoryTabWheelDelta(
  strip: HTMLDivElement,
  event: Pick<WheelEvent, "deltaMode" | "deltaY">,
): number {
  if (event.deltaMode === WHEEL_DELTA_LINE) {
    return event.deltaY * WHEEL_LINE_PIXELS;
  }
  if (event.deltaMode === WHEEL_DELTA_PAGE) {
    return event.deltaY * strip.clientWidth;
  }
  return event.deltaY;
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
  const mouseDragHandlers = useHorizontalMouseDrag(stripRef);

  useEffect(() => {
    const strip = stripRef.current;
    const revealActive = () => revealCategoryTab(strip, activeRef.current);
    revealActive();
    if (!strip || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealActive);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activeId, activeIndex]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof strip.addEventListener !== "function") return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaX !== 0 || event.deltaY === 0) return;
      if (!(strip.scrollWidth > strip.clientWidth)) return;
      const delta = normalizeCategoryTabWheelDelta(strip, event);
      if (delta === 0) return;
      event.preventDefault();
      strip.scrollBy({ left: delta });
    };
    strip.addEventListener("wheel", handleWheel, { passive: false });
    return () => strip.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <div
      aria-label={t("categories.title")}
      className="norea-library-category-tabs"
      ref={stripRef}
      role="group"
      {...mouseDragHandlers}
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

interface CategoryRowReorderControls {
  canMoveDown: boolean;
  canMoveUp: boolean;
  disabled: boolean;
  onMoveDown: () => void;
  onMoveUp: () => void;
}

interface SortableCategoryRowProps {
  active: boolean;
  category: LibraryCategory;
  count: number;
  onDelete: () => void;
  onRename: () => void;
  onSelect: () => void;
  reorder: CategoryRowReorderControls;
}

function SortableCategoryRow({
  active,
  category,
  count,
  onDelete,
  onRename,
  onSelect,
  reorder,
}: SortableCategoryRowProps) {
  const { t } = useTranslation();
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: categoryDndId(category.id),
    disabled: reorder.disabled,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  const menuItems: OverflowMenuItem[] = [
    {
      disabled: reorder.disabled || !reorder.canMoveUp,
      icon: ChevronUpIcon,
      label: t("categories.moveUp"),
      onClick: reorder.onMoveUp,
    },
    {
      disabled: reorder.disabled || !reorder.canMoveDown,
      icon: ChevronDownIcon,
      label: t("categories.moveDown"),
      onClick: reorder.onMoveDown,
    },
    {
      icon: EditIcon,
      label: t("categories.rename"),
      onClick: onRename,
    },
    {
      danger: true,
      icon: TrashIcon,
      label: t("categories.delete"),
      onClick: onDelete,
    },
  ];

  return (
    <li
      className="norea-library-category-row"
      data-active={active}
      data-dragging={isDragging ? "true" : undefined}
      data-sortable="true"
      ref={setNodeRef}
      style={style}
    >
      <IconButton
        {...(reorder.disabled ? undefined : attributes)}
        {...(reorder.disabled ? undefined : listeners)}
        className="norea-library-category-drag-handle"
        disabled={reorder.disabled}
        label={t("categories.reorderFor", { name: category.name })}
        size="lg"
        type="button"
      >
        <DragIcon size="1.25rem" />
      </IconButton>
      <UnstyledButton
        aria-current={active ? "true" : undefined}
        className="norea-library-category norea-state-layer"
        onClick={onSelect}
      >
        <span className="norea-library-category-label">{category.name}</span>
        <span className="norea-library-category-count">
          {count.toLocaleString()}
        </span>
      </UnstyledButton>
      <OverflowMenu
        items={menuItems}
        label={t("categories.actionsFor", { name: category.name })}
      />
    </li>
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
  onReorder?: (orderedIds: number[]) => void;
  onSelect: (id: number | null) => void;
  reordering?: boolean;
}

/**
 * Category rows with counts, drag-and-drop ordering for manual categories, a
 * per-row overflow for move/rename/delete, and "+ Category". Shared by the
 * desktop panel and Manage categories.
 */
export function CategoryList({
  activeId,
  entries,
  error,
  loading,
  onCreate,
  onDelete,
  onRename,
  onReorder,
  onSelect,
  reordering = false,
}: CategoryListProps) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const manualCategoryIds = useMemo(
    () =>
      entries.flatMap((entry) => (entry.category ? [entry.category.id] : [])),
    [entries],
  );
  const canReorder = Boolean(onReorder) && manualCategoryIds.length > 1;
  const sortableCategoryIds = useMemo(
    () => (canReorder ? manualCategoryIds.map(categoryDndId) : []),
    [canReorder, manualCategoryIds],
  );
  const manualIndexById = useMemo(
    () => new Map(manualCategoryIds.map((id, index) => [id, index] as const)),
    [manualCategoryIds],
  );

  const moveCategory = (categoryId: number, offset: -1 | 1) => {
    if (!onReorder || reordering) return;
    const fromIndex = manualIndexById.get(categoryId);
    if (fromIndex === undefined) return;
    const targetId = manualCategoryIds[fromIndex + offset];
    if (targetId === undefined) return;
    const nextOrder = reorderCategoryIds(manualCategoryIds, categoryId, targetId);
    if (nextOrder) onReorder(nextOrder);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (!canReorder || !onReorder || reordering) return;
    const overId = event.over?.id;
    if (overId === undefined) return;
    const activeCategoryId = parseCategoryDndId(event.active.id);
    const overCategoryId = parseCategoryDndId(overId);
    if (activeCategoryId === null || overCategoryId === null) return;
    const nextOrder = reorderCategoryIds(
      manualCategoryIds,
      activeCategoryId,
      overCategoryId,
    );
    if (nextOrder) onReorder(nextOrder);
  };

  const rows = (
    <ul aria-label={t("categories.title")}>
      {entries.map((entry) => {
        const active = entry.id === activeId;
        const { category } = entry;
        if (category && canReorder) {
          const manualIndex = manualIndexById.get(category.id) ?? -1;
          return (
            <SortableCategoryRow
              active={active}
              category={category}
              count={entry.count}
              key={category.id}
              onDelete={() => onDelete(category)}
              onRename={() => onRename(category)}
              onSelect={() => onSelect(entry.id)}
              reorder={{
                canMoveDown:
                  manualIndex >= 0 && manualIndex < manualCategoryIds.length - 1,
                canMoveUp: manualIndex > 0,
                disabled: reordering,
                onMoveDown: () => moveCategory(category.id, 1),
                onMoveUp: () => moveCategory(category.id, -1),
              }}
            />
          );
        }
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
  );

  return (
    <div className="norea-library-category-list">
      {canReorder ? (
        <DndContext
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
          sensors={sensors}
        >
          <SortableContext
            items={sortableCategoryIds}
            strategy={verticalListSortingStrategy}
          >
            {rows}
          </SortableContext>
        </DndContext>
      ) : (
        rows
      )}
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
