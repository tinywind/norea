import { Skeleton } from "@mantine/core";

const SKELETON_CARDS = 12;

/** Placeholder cards in the source cover grid while its first page loads. */
export function CoverGridSkeleton({ label }: { label: string }) {
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
