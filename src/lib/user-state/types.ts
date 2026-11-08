import { parseChapterComposition, type ChapterCompositionV1 } from "../chapter-composition";

export const USER_STATE_VERSION = 1 as const;
export const USER_STATE_MAX_BATCH = 200;
export const USER_STATE_MAX_BYTES = 32 * 1024 * 1024;
export const USER_STATE_CLIENT_BATCH_BYTES = 30 * 1024 * 1024;

export interface UserStateWorkReference {
  pluginId: string;
  sourceNovelId: string | null;
  novelPath: string;
  name: string;
}
export interface UserStateChapterReference {
  chapterPath: string;
  compositionEntryId?: string;
  name?: string;
}
export interface PortableReaderAnchor {
  segmentIndex: number;
  mediaOrdinal?: number;
  offset: number;
  segmentCount: number;
  progress: number;
  savedAt: number;
}
export type UserStateEntity =
  | { kind: "library" | "resume" | "composition"; work: UserStateWorkReference }
  | { kind: "category"; categoryId: string }
  | { kind: "membership"; work: UserStateWorkReference; categoryId: string }
  | { kind: "reading" | "bookmark"; work: UserStateWorkReference; chapter: UserStateChapterReference };
export type UserStateKind = UserStateEntity["kind"];
export interface UserStateValueMap {
  library: { inLibrary: boolean; addedAt: number | null };
  category: { name: string; sort: number; deleted: boolean };
  membership: { included: boolean };
  reading: { progress: number; unread: boolean; readAt: number | null };
  bookmark: { bookmarked: boolean };
  resume: { chapter: UserStateChapterReference | null; anchor: PortableReaderAnchor | null; openedAt: number | null };
  composition: { composition: ChapterCompositionV1 };
}
export type UserStateValue = UserStateValueMap[UserStateKind];
export interface UserStateOperation {
  operationId: string;
  entity: UserStateEntity;
  baseRevision: number;
  value: UserStateValue;
  seed?: true;
}
export interface UserStateRecord {
  entity: UserStateEntity;
  value: UserStateValue;
  revision: number;
  operationId: string;
  updatedAt: number;
  deviceId: string;
  deviceName: string;
}
export interface UserStateWorkspace {
  version: 1;
  workspaceId: string;
  epoch: string;
  headRevision: number;
}
export interface UserStateBinding {
  serverUrl: string;
  workspaceId: string;
  epoch: string;
}
export interface UserStateReadResponse extends UserStateWorkspace {
  through: number;
  nextCursor: number;
  hasMore: boolean;
  records: UserStateRecord[];
}
export type UserStateMergeStatus = "applied" | "unchanged" | "seed-skipped" | "conflict" | "aliased";
export interface UserStateMergeResult {
  operationId: string;
  status: UserStateMergeStatus;
  current: UserStateRecord | null;
  reason?: string;
  categoryAlias?: { from: string; to: string };
}
export interface UserStateMergeResponse extends UserStateWorkspace {
  results: UserStateMergeResult[];
}
export interface UserStateConflict {
  id: string;
  categoryName?: string;
  entity: UserStateEntity;
  local: UserStateValue;
  shared: UserStateRecord | null;
  reason: string;
  version: string;
}
export interface UserStateDeferred {
  id: string;
  categoryName?: string;
  entity: UserStateEntity;
  reason: string;
  detail?: string;
}
export interface UserStateStatus {
  pausedAfterRestore?: boolean;
  workspaceId: string | null;
  epoch: string | null;
  pending: number;
  conflicts: UserStateConflict[];
  deferred: UserStateDeferred[];
  lastSuccessAt: number | null;
}
export interface ResolveUserStateConflictInput {
  conflictId: string;
  version: string;
  choice: "local" | "shared";
  categoryName?: string;
}
export interface UserStateResumeEffect {
  novelId: number;
  chapterId: number | null;
  anchor: PortableReaderAnchor | null;
  openedAt: number | null;
}
export interface UserStateApplyEffects {
  resumes: UserStateResumeEffect[];
}

export class UserStateProtocolError extends Error {
  readonly code = "invalidResponse";
  constructor(message: string) {
    super("User state: " + message);
    this.name = "UserStateProtocolError";
  }
}
function fail(message: string): never { throw new UserStateProtocolError(message); }
function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid " + label);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) fail("unexpected field in " + label);
  return row;
}
function textValue(value: unknown, label: string, maximum: number, empty = false, identity = false): string {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()) ||
      (identity ? /[\u0000-\u001f\u007f]/ : /\u0000/).test(value)) fail("invalid " + label);
  return value;
}
function identifier(value: unknown, label: string): string {
  const result = textValue(value, label, 128, false, true);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) fail("invalid " + label);
  return result;
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("invalid " + label);
  return value;
}
function numberRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail("invalid " + label);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail("invalid " + label);
  return value;
}
function nullableTime(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}
export function parseUserStateWorkReference(value: unknown): UserStateWorkReference {
  const row = object(value, ["pluginId", "sourceNovelId", "novelPath", "name"], "work reference");
  return {
    pluginId: textValue(row.pluginId, "plugin ID", 160, false, true),
    sourceNovelId: row.sourceNovelId === null ? null : textValue(row.sourceNovelId, "source work ID", 1024, false, true),
    novelPath: textValue(row.novelPath, "source work path", 8192, false, true),
    name: textValue(row.name, "work name", 4096, true),
  };
}
export function parseUserStateChapterReference(value: unknown): UserStateChapterReference {
  const row = object(value, ["chapterPath", "compositionEntryId", "name"], "chapter reference");
  return {
    chapterPath: textValue(row.chapterPath, "source chapter path", 8192, false, true),
    ...(row.compositionEntryId !== undefined ? { compositionEntryId: identifier(row.compositionEntryId, "composition entry ID") } : {}),
    ...(row.name !== undefined ? { name: textValue(row.name, "chapter name", 4096, true) } : {}),
  };
}
export function parsePortableReaderAnchor(value: unknown): PortableReaderAnchor {
  const row = object(value, ["segmentIndex", "mediaOrdinal", "offset", "segmentCount", "progress", "savedAt"], "reader anchor");
  const segmentCount = integer(row.segmentCount, "reader segment count", 1);
  const segmentIndex = integer(row.segmentIndex, "reader segment index");
  if (segmentCount > 1_000_000 || segmentIndex >= segmentCount) fail("reader anchor is outside its document");
  const mediaOrdinal = row.mediaOrdinal === undefined ? undefined : integer(row.mediaOrdinal, "reader media ordinal");
  if (mediaOrdinal !== undefined && mediaOrdinal > 1_000_000) fail("reader media ordinal exceeds the limit");
  return {
    segmentIndex, segmentCount,
    ...(mediaOrdinal !== undefined ? { mediaOrdinal } : {}),
    offset: numberRange(row.offset, "reader offset fraction", 0, 1),
    progress: numberRange(row.progress, "reader progress", 0, 100),
    savedAt: integer(row.savedAt, "reader anchor time"),
  };
}
export function parseUserStateEntity(value: unknown): UserStateEntity {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid entity");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "category") {
    const row = object(value, ["kind", "categoryId"], "category entity");
    return { kind, categoryId: identifier(row.categoryId, "category ID") };
  }
  if (kind === "membership") {
    const row = object(value, ["kind", "work", "categoryId"], "membership entity");
    return { kind, work: parseUserStateWorkReference(row.work), categoryId: identifier(row.categoryId, "category ID") };
  }
  if (kind === "reading" || kind === "bookmark") {
    const row = object(value, ["kind", "work", "chapter"], "chapter entity");
    return { kind, work: parseUserStateWorkReference(row.work), chapter: parseUserStateChapterReference(row.chapter) };
  }
  if (kind === "library" || kind === "resume" || kind === "composition") {
    const row = object(value, ["kind", "work"], "work entity");
    return { kind, work: parseUserStateWorkReference(row.work) };
  }
  return fail("unknown entity kind");
}
export function parseUserStateValue(kind: UserStateKind, value: unknown): UserStateValue {
  switch (kind) {
    case "library": {
      const row = object(value, ["inLibrary", "addedAt"], "library value");
      return { inLibrary: bool(row.inLibrary, "library membership"), addedAt: nullableTime(row.addedAt, "library added time") };
    }
    case "category": {
      const row = object(value, ["name", "sort", "deleted"], "category value");
      return { name: textValue(row.name, "category name", 512), sort: integer(row.sort, "category order", -Number.MAX_SAFE_INTEGER), deleted: bool(row.deleted, "category deletion") };
    }
    case "membership": {
      const row = object(value, ["included"], "membership value");
      return { included: bool(row.included, "category membership") };
    }
    case "reading": {
      const row = object(value, ["progress", "unread", "readAt"], "reading value");
      return { progress: numberRange(row.progress, "reading progress", 0, 100), unread: bool(row.unread, "unread flag"), readAt: nullableTime(row.readAt, "read time") };
    }
    case "bookmark": {
      const row = object(value, ["bookmarked"], "bookmark value");
      return { bookmarked: bool(row.bookmarked, "bookmark flag") };
    }
    case "resume": {
      const row = object(value, ["chapter", "anchor", "openedAt"], "resume value");
      const chapter = row.chapter === null ? null : parseUserStateChapterReference(row.chapter);
      const anchor = row.anchor === null ? null : parsePortableReaderAnchor(row.anchor);
      if (!chapter && anchor) fail("an empty resume cannot contain an anchor");
      return { chapter, anchor, openedAt: nullableTime(row.openedAt, "resume opened time") };
    }
    case "composition": {
      const row = object(value, ["composition"], "composition value");
      return { composition: parseChapterComposition(row.composition) };
    }
  }
}

/** SQLite lower() folds ASCII. Titles and mutable paths never replace a known source ID. */
export function userStateWorkKey(work: UserStateWorkReference): string {
  return JSON.stringify(work.sourceNovelId === null
    ? [work.pluginId, "path", work.novelPath]
    : [work.pluginId, "id", work.sourceNovelId.replace(/[A-Z]/g, character => character.toLowerCase())]);
}
export function userStateEntityKey(entity: UserStateEntity): string {
  if (entity.kind === "category") return JSON.stringify(["category", entity.categoryId]);
  const work = userStateWorkKey(entity.work);
  if (entity.kind === "membership") return JSON.stringify(["membership", work, entity.categoryId]);
  if (entity.kind === "reading" || entity.kind === "bookmark") return JSON.stringify([entity.kind, work, entity.chapter.chapterPath]);
  return JSON.stringify([entity.kind, work]);
}
function requirePortableEntity(entity: UserStateEntity): void {
  if ("work" in entity && entity.work.sourceNovelId === null) fail("missing stable source work identity");
  if ((entity.kind === "reading" || entity.kind === "bookmark") &&
      /^(?:(?:norea|local)-folder):/.test(entity.chapter.chapterPath)) fail("unresolved recovered chapter identity");
}
function portableValue(entity: UserStateEntity, raw: unknown): UserStateValue {
  const value = parseUserStateValue(entity.kind, raw);
  if (entity.kind === "resume") {
    const chapter = (value as UserStateValueMap["resume"]).chapter;
    if (chapter && /^(?:(?:norea|local)-folder):/.test(chapter.chapterPath)) fail("unresolved recovered chapter identity");
  }
  return value;
}
export function parseUserStateOperation(value: unknown): UserStateOperation {
  const row = object(value, ["operationId", "entity", "baseRevision", "value", "seed"], "operation");
  const entity = parseUserStateEntity(row.entity);
  requirePortableEntity(entity);
  if (row.seed !== undefined && row.seed !== true) fail("invalid seed flag");
  const baseRevision = integer(row.baseRevision, "base revision");
  if (row.seed === true && baseRevision !== 0) fail("a seed must have no prior revision");
  return {
    operationId: identifier(row.operationId, "operation ID"), entity, baseRevision,
    value: portableValue(entity, row.value),
    ...(row.seed === true ? { seed: true } : {}),
  };
}
export function parseUserStateRecord(value: unknown): UserStateRecord {
  const row = object(value, ["entity", "value", "revision", "operationId", "updatedAt", "deviceId", "deviceName"], "record");
  const entity = parseUserStateEntity(row.entity);
  requirePortableEntity(entity);
  return {
    entity, value: portableValue(entity, row.value), revision: integer(row.revision, "record revision", 1),
    operationId: identifier(row.operationId, "operation ID"), updatedAt: integer(row.updatedAt, "server update time"),
    deviceId: textValue(row.deviceId, "author device ID", 256, false, true),
    deviceName: textValue(row.deviceName, "author device name", 256, true),
  };
}
function workspaceFields(row: Record<string, unknown>): UserStateWorkspace {
  if (row.version !== USER_STATE_VERSION) fail("unsupported protocol version");
  return {
    version: USER_STATE_VERSION,
    workspaceId: identifier(row.workspaceId, "workspace ID"),
    epoch: identifier(row.epoch, "workspace epoch"),
    headRevision: integer(row.headRevision, "head revision"),
  };
}
export function parseUserStateWorkspace(value: unknown): UserStateWorkspace {
  return workspaceFields(object(value, ["version", "workspaceId", "epoch", "headRevision"], "workspace"));
}
export function parseUserStateReadResponse(value: unknown): UserStateReadResponse {
  const row = object(value, ["version", "workspaceId", "epoch", "headRevision", "through", "nextCursor", "hasMore", "records"], "read response");
  const workspace = workspaceFields(row);
  const through = integer(row.through, "read boundary");
  const nextCursor = integer(row.nextCursor, "next cursor");
  const hasMore = bool(row.hasMore, "has more flag");
  if (through > workspace.headRevision || nextCursor > through || (!hasMore && nextCursor !== through)) fail("inconsistent read cursors");
  if (!Array.isArray(row.records) || row.records.length > USER_STATE_MAX_BATCH) fail("invalid record page");
  const records = row.records.map(parseUserStateRecord);
  if (hasMore && (!records.length || nextCursor >= through)) fail("a continuing page must make progress");
  for (let index = 0; index < records.length; index++) {
    if (records[index].revision > nextCursor || (index && records[index].revision <= records[index - 1].revision)) fail("records are not in revision order");
  }
  if (hasMore && records[records.length - 1].revision !== nextCursor) fail("continuing page does not end at its cursor");
  return { ...workspace, through, nextCursor, hasMore, records };
}
export function parseUserStateMergeResult(value: unknown): UserStateMergeResult {
  const row = object(value, ["operationId", "status", "current", "reason", "categoryAlias"], "merge result");
  const statuses: readonly unknown[] = ["applied", "unchanged", "seed-skipped", "conflict", "aliased"];
  if (!statuses.includes(row.status)) fail("invalid merge result status");
  const current = row.current === null ? null : parseUserStateRecord(row.current);
  if (row.status !== "conflict" && !current) fail("an acknowledged change must include its record");
  let categoryAlias: { from: string; to: string } | undefined;
  if (row.categoryAlias !== undefined) {
    const alias = object(row.categoryAlias, ["from", "to"], "category alias");
    categoryAlias = { from: identifier(alias.from, "alias source"), to: identifier(alias.to, "alias target") };
    if (categoryAlias.from === categoryAlias.to ||
        (current && (current.entity.kind !== "category" && current.entity.kind !== "membership" ||
          !("categoryId" in current.entity) || current.entity.categoryId !== categoryAlias.to))) fail("invalid category alias target");
  }
  if (row.status === "aliased" && !categoryAlias) fail("an aliased result must identify the shared category");
  return {
    operationId: identifier(row.operationId, "operation ID"), status: row.status as UserStateMergeStatus, current,
    ...(row.reason === undefined ? {} : { reason: textValue(row.reason, "conflict reason", 256, false, true) }),
    ...(categoryAlias ? { categoryAlias } : {}),
  };
}
export function parseUserStateMergeResponse(value: unknown): UserStateMergeResponse {
  const row = object(value, ["version", "workspaceId", "epoch", "headRevision", "results"], "merge response");
  const workspace = workspaceFields(row);
  if (!Array.isArray(row.results) || row.results.length > USER_STATE_MAX_BATCH) fail("invalid merge result batch");
  const results = row.results.map(parseUserStateMergeResult);
  if (new Set(results.map(result => result.operationId)).size !== results.length) fail("duplicate operation acknowledgement");
  if (results.some(result => result.current && result.current.revision > workspace.headRevision)) fail("record exceeds the acknowledged head");
  return { ...workspace, results };
}

/** Stable encoding also rejects values the transport must never serialize. */
export function canonicalUserStateJson(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) return "[" + input.map(encode).join(",") + "]";
    if (input && typeof input === "object") {
      const row = input as Record<string, unknown>;
      return "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + encode(row[key])).join(",") + "}";
    }
    return fail("value is not portable JSON");
  };
  return encode(value);
}
export function userStateJsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("value is not portable JSON");
  return new TextEncoder().encode(encoded).byteLength;
}
