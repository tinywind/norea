import type { CSSProperties } from "react";
import { Skeleton } from "@mantine/core";
import { DEFAULT_SOURCE_NOVELS_PER_ROW } from "../../store/browse";
import type { LibraryDisplayMode } from "../../store/library";

const SKELETON_CARDS = 12;

interface CoverGridSkeletonProps {
  displayMode?: LibraryDisplayMode;
  label: string;
  novelsPerRow?: number;
}

/** Placeholder cards in the source cover grid or list while its first page loads. */
export function CoverGridSkeleton({
  displayMode,
  label,
  novelsPerRow = DEFAULT_SOURCE_NOVELS_PER_ROW,
}: CoverGridSkeletonProps) {
  if (displayMode === "list") {
    return (
      <div
        aria-busy="true"
        aria-label={label}
        className="norea-source-catalog-list"
        data-mode="list"
        role="status"
      >
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <div className="norea-source-skeleton-row" key={index}>
            <Skeleton height="3.75rem" radius="sm" width="2.5rem" />
            <span className="norea-source-skeleton-lines">
              <Skeleton height="0.75rem" radius="sm" width="60%" />
              <Skeleton height="0.625rem" radius="sm" width="35%" />
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (displayMode) {
    return (
      <div
        aria-busy="true"
        aria-label={label}
        className="norea-source-catalog-grid"
        data-mode={displayMode}
        role="status"
        style={{ "--norea-source-grid-columns": novelsPerRow } as CSSProperties}
      >
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <div className="norea-source-skeleton-card" key={index}>
            <Skeleton className="norea-source-skeleton-cover" radius="sm" />
            {displayMode === "comfortable" ? (
              <>
                <Skeleton height="0.75rem" radius="sm" width="85%" />
                <Skeleton height="0.625rem" radius="sm" width="50%" />
              </>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div aria-busy="true" aria-label={label} className="norea-source-grid" role="status">
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <div className="norea-source-card-skeleton" key={index}>
          <Skeleton height="9.5rem" radius="sm" width="6.5rem" />
          <Skeleton height="0.875rem" radius="sm" width="80%" />
        </div>
      ))}
    </div>
  );
}
