import {
  canonicalUserStateJson, parseUserStateEntity, parseUserStateValue, UserStateProtocolError, userStateJsonBytes, userStateEntityKey,
  type UserStateApplyEffects, type UserStateEntity, type UserStateValue, type UserStateValueMap,
} from "./types";
import { parseStoredChapterPath, STORED_CHAPTER_PREFIX } from "./stored-chapter";

export const USER_STATE_CURRENT_VERSION = 2 as const;
export const USER_STATE_CURRENT_MAX_ITEMS = 100_000;
export const USER_STATE_CURRENT_MAX_BYTES = 32 * 1024 * 1024;

export interface UserStateCurrentItem {
  entity: UserStateEntity;
  value: UserStateValue;
}
export interface UserStateCurrentSnapshot {
  version: typeof USER_STATE_CURRENT_VERSION;
  workspaceId: string;
  epoch: string;
  items: UserStateCurrentItem[];
}
export interface UserStateCurrentStatus {
  workspaceId: string | null;
  epoch: string | null;
  lastSuccessAt: number | null;
  pausedAfterRestore: boolean;
  missingMetadataCount: number;
}
export interface UserStateCurrentApplyResult extends UserStateApplyEffects {
  missingMetadataCount: number;
  changed: boolean;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new UserStateProtocolError("invalid current snapshot object");
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value))
    throw new UserStateProtocolError("invalid current workspace identity");
  return value;
}
export function parseUserStateCurrentItem(raw: unknown): UserStateCurrentItem {
  const input = object(raw, ["entity", "value"]);
  const entity = parseUserStateEntity(input.entity);
  const value = parseUserStateValue(entity.kind, input.value);
  if ("work" in entity && !entity.work.sourceNovelId) throw new UserStateProtocolError("missing stable source work identity");
  const chapter = entity.kind === "reading" || entity.kind === "bookmark" ? entity.chapter :
    entity.kind === "resume" ? (value as UserStateValueMap["resume"]).chapter : null;
  if (chapter && (/^(?:norea|local)-folder:/.test(chapter.chapterPath) ||
      /^norea-(?:composed|source):/.test(chapter.chapterPath) && !chapter.compositionEntryId ||
      chapter.chapterPath.startsWith(STORED_CHAPTER_PREFIX) && !parseStoredChapterPath(chapter.chapterPath)))
    throw new UserStateProtocolError("unresolved current chapter identity");
  if (entity.kind === "library" && !(value as UserStateValueMap["library"]).inLibrary ||
      entity.kind === "bookmark" && !(value as UserStateValueMap["bookmark"]).bookmarked ||
      entity.kind === "membership" && !(value as UserStateValueMap["membership"]).included ||
      entity.kind === "category" && (value as UserStateValueMap["category"]).deleted ||
      entity.kind === "resume" && !(value as UserStateValueMap["resume"]).chapter)
    throw new UserStateProtocolError("current snapshots contain additive state only");
  if (entity.kind === "category") {
    const category = value as UserStateValueMap["category"];
    category.name = category.name.trim();
    if (!category.name) throw new UserStateProtocolError("empty current category name");
  }
  return { entity, value };
}
export function parseUserStateCurrentSnapshot(raw: unknown): UserStateCurrentSnapshot {
  if (userStateJsonBytes(raw) > USER_STATE_CURRENT_MAX_BYTES) throw new UserStateProtocolError("current snapshot exceeds the byte limit");
  const input = object(raw, ["version", "workspaceId", "epoch", "items"]);
  if (input.version !== USER_STATE_CURRENT_VERSION || !Array.isArray(input.items) || input.items.length > USER_STATE_CURRENT_MAX_ITEMS)
    throw new UserStateProtocolError("invalid current snapshot version or item count");
  const items = input.items.map(parseUserStateCurrentItem);
  const keys = new Set(items.map(item => userStateEntityKey(item.entity)));
  if (keys.size !== items.length) throw new UserStateProtocolError("duplicate current snapshot entity");
  return { version: USER_STATE_CURRENT_VERSION, workspaceId: identity(input.workspaceId), epoch: identity(input.epoch), items };
}

/** A stale full export cannot regress an equally dated public reading position. */
export function mergeUserStateCurrentReading(
  left: UserStateValueMap["reading"], right: UserStateValueMap["reading"],
): UserStateValueMap["reading"] {
  if ((left.readAt ?? -1) !== (right.readAt ?? -1)) return (left.readAt ?? -1) > (right.readAt ?? -1) ? left : right;
  return { progress: Math.max(left.progress, right.progress), unread: left.unread && right.unread, readAt: left.readAt };
}
export function mergeUserStateCurrentResume(
  left: UserStateValueMap["resume"], right: UserStateValueMap["resume"],
): UserStateValueMap["resume"] {
  if (!left.chapter) return right;
  if (!right.chapter) return left;
  const leftTime = left.openedAt ?? -1;
  const rightTime = right.openedAt ?? -1;
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  const leftAnchor = left.anchor?.savedAt ?? -1;
  const rightAnchor = right.anchor?.savedAt ?? -1;
  if (leftAnchor !== rightAnchor) return leftAnchor > rightAnchor ? left : right;
  return canonicalUserStateJson(left) <= canonicalUserStateJson(right) ? left : right;
}
