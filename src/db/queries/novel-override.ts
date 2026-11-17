import type { WorkOverrideV1 } from "../../lib/work-metadata/override";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export interface StoredNovelOverride {
  novelId: number;
  isLocal: boolean;
  document: WorkOverrideV1;
}

export function getNovelOverride(novelId: number): Promise<WorkOverrideV1 | null> {
  return invokeDbQuery<WorkOverrideV1 | null>("db_novel_override_get", {
    novelId,
    mode: "queued",
  });
}

/** Every novel that has an override, ordered by novel id. */
export function listNovelOverrides(): Promise<StoredNovelOverride[]> {
  return invokeDbQuery<StoredNovelOverride[]>("db_novel_override_list", {
    mode: "queued",
  });
}

/** `completed`: true / false, or null to follow the source status again. Uses Date.now() for updatedAt. */
export function setNovelCompletedOverride(
  novelId: number,
  completed: boolean | null,
): Promise<WorkOverrideV1> {
  return invokeDbMutation<WorkOverrideV1>("db_novel_override_set_field", {
    novelId,
    field: "completed",
    value: completed,
    updatedAt: Date.now(),
  });
}

/** Stores `merge(local, document)` under the novel's own identity; `document` is null only when nothing is stored. */
export function mergeNovelOverride(
  novelId: number,
  document: WorkOverrideV1,
): Promise<{ document: WorkOverrideV1 | null; changed: boolean }> {
  return invokeDbMutation<{ document: WorkOverrideV1 | null; changed: boolean }>(
    "db_novel_override_merge",
    { novelId, document },
  );
}
