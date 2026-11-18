import type { WorkOverrideV1 } from "../../lib/work-metadata/override";
import { invokeDbMutation, invokeDbQuery, type DbReadMode } from "../ipc";

export interface StoredNovelOverride {
  novelId: number;
  isLocal: boolean;
  document: WorkOverrideV1;
}

export type NovelOverrideCoverAction =
  | { mode: "keep" }
  | { mode: "clear" }
  | { mode: "set"; fileName: string; bytes: Uint8Array };

export interface NovelOverrideCoverBytes {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export type WorkOverrideUpdateFields = Record<string, string | number | boolean | null>;

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

export async function readNovelOverrideCover(
  novelId: number,
  mode: DbReadMode = "queued",
): Promise<NovelOverrideCoverBytes | null> {
  const result = await invokeDbQuery<
    (Omit<NovelOverrideCoverBytes, "bytes"> & { bytes: number[] }) | null
  >("db_novel_override_read_cover", {
    novelId,
    mode,
  });
  if (!result) return null;
  return {
    fileName: result.fileName,
    contentType: result.contentType,
    bytes: new Uint8Array(result.bytes),
  };
}

/**
 * Atomically updates user override fields (`null` reverts a field to source)
 * and optionally sets or clears `cover.override.<ext>`.
 */
export function updateNovelOverride(
  novelId: number,
  fields: WorkOverrideUpdateFields,
  cover: NovelOverrideCoverAction = { mode: "keep" },
  updatedAt: number = Date.now(),
): Promise<WorkOverrideV1> {
  const coverPayload =
    cover.mode === "set"
      ? { mode: "set", fileName: cover.fileName, bytes: Array.from(cover.bytes) }
      : cover;
  return invokeDbMutation<WorkOverrideV1>("db_novel_override_update", {
    novelId,
    fields,
    cover: coverPayload,
    updatedAt,
  });
}

/** Stores `merge(local, document)` under the novel's own identity; `document` is null only when nothing is stored. */
export function mergeNovelOverride(
  novelId: number,
  document: WorkOverrideV1,
  coverBytes?: Uint8Array | null,
): Promise<{ document: WorkOverrideV1 | null; changed: boolean }> {
  return invokeDbMutation<{ document: WorkOverrideV1 | null; changed: boolean }>(
    "db_novel_override_merge",
    {
      novelId,
      document,
      ...(coverBytes ? { coverBytes: Array.from(coverBytes) } : {}),
    },
  );
}
