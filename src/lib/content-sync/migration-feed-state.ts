import type Database from "@tauri-apps/plugin-sql";
import { getDb, runDatabaseTransaction } from "../../db/client";
import { isChapterPayloadInventory, type ChapterPayloadInventory } from "../chapter-content/inventory";
import { canonicalMetadataValue, parseNovelMetadata, type NovelMetadataV1 } from "../work-metadata/schema";
import { normalizeContentServerUrl } from "./client";
import type { MigrationWorkIdentity } from "./novel-migration-types";

export interface MigrationLineageWork {
  id: string;
  revision: string;
  identity: MigrationWorkIdentity;
  metadata: NovelMetadataV1;
  coverSha256: string | null;
}

export interface MigrationLineageChapter {
  id: string;
  revision: string;
  chapterPath: string;
  chapterNumber: string | null;
  position: number;
  name: string;
  complete: boolean;
  available: boolean;
}

export interface MigrationLineageChapterDecision {
  discardSourceContent?: true;
  sourceChapterPath: string;
  sourceChapterNumber: string | null;
  targetChapterPath: string | null;
  targetChapterNumber: string | null;
  sourceMetadataVerified: boolean;
  targetMetadataVerified: boolean;
}

export type MigrationLineageMapping = { source: MigrationLineageChapter } & ({
  decision: "copy-source" | "keep-target";
  target: MigrationLineageChapter;
  targetInventory: ChapterPayloadInventory;
} | {
  decision: "delete-source";
  target: null;
  targetInventory: null;
});

export interface WorkMigrationLineage {
  sequence: number;
  operationId: string;
  sourceWork: MigrationLineageWork;
  targetWork: MigrationLineageWork;
  deletedSource: { revision: string; sequence: number };
  mappings: MigrationLineageMapping[];
  chapterDecisions: MigrationLineageChapterDecision[];
  fullDecisionCoverage: boolean;
  active: boolean;
}

export interface IncomingMigration {
  version: 1;
  serverUrl: string;
  operationId: string;
  sequence: number;
  source: MigrationWorkIdentity;
  target: MigrationWorkIdentity;
  status: "pending" | "failed" | "blocked" | "completed" | "inactive";
  lineage: WorkMigrationLineage;
  error?: string;
}

export const INCOMING_MIGRATION_CACHE_PREFIX = "norea-content-incoming-migration:";
const CURSOR_PREFIX = "norea-content-incoming-migration-cursor:";
const MAX_CHAPTERS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonical = (value: unknown) => JSON.stringify(canonicalMetadataValue(value));
const invalid = (detail: string): never => { throw new Error("Incoming work migration is invalid: " + detail + ". Synchronization was held."); };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit ||
      Array.from(value).some(character => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) return invalid(label);
  return value;
}

function path(value: unknown): string {
  const result = text(value, "chapter path");
  if (/[\u0000-\u001f\u007f]/.test(result)) return invalid("chapter path");
  return result;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return invalid("digest or identity");
  return value;
}

function sequence(value: unknown, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) return invalid("sequence");
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid("boolean flag");
  return value;
}

function number(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 100 || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) return invalid("chapter number");
  return value;
}

const numberKey = (value: string | null) => value === null ? null : String(Number(value));

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_CHAPTERS) return invalid("chapter collection");
  return value;
}

function work(value: unknown): MigrationLineageWork {
  const input = object(value);
  const metadata = parseNovelMetadata(input.metadata);
  if (metadata.novel.isLocal || metadata.identity.pluginId === "local" ||
      canonical(input.identity) !== canonical(metadata.identity) ||
      /[\u0000-\u001f\u007f]/.test(metadata.identity.novelPath)) return invalid("work identity or metadata");
  const coverSha256 = input.coverSha256 === null ? null : hash(input.coverSha256);
  if (!metadata.cover && coverSha256 !== null) return invalid("cover digest without a cover");
  return { id: hash(input.id), revision: hash(input.revision), identity: { ...metadata.identity }, metadata, coverSha256 };
}

function chapter(value: unknown): MigrationLineageChapter {
  const input = object(value);
  if (typeof input.position !== "number" || !Number.isFinite(input.position) || input.position < 0) return invalid("chapter position");
  return {
    id: hash(input.id), revision: hash(input.revision), chapterPath: path(input.chapterPath),
    chapterNumber: number(input.chapterNumber), position: input.position, name: text(input.name, "chapter name"),
    complete: flag(input.complete), available: flag(input.available),
  };
}

function inventory(value: unknown): ChapterPayloadInventory {
  if (!isChapterPayloadInventory(value) || !value.body || value.body.bytes <= 0 ||
      value.storedAssets.length > MAX_CHAPTERS || (value.expectedAssetKeys?.length ?? 0) > MAX_CHAPTERS) return invalid("verified target inventory");
  const stored = new Set(value.storedAssets.map(asset => asset.key));
  if (value.expectedAssetKeys === null ? value.storedAssets.length !== 0 :
      value.expectedAssetKeys.some(key => !stored.has(key))) return invalid("verified target inventory");
  return {
    body: { ...value.body }, expectedAssetKeys: value.expectedAssetKeys && [...value.expectedAssetKeys],
    storedAssets: value.storedAssets.map(asset => ({ key: asset.key, sha256: asset.sha256, bytes: asset.bytes })),
  };
}

function mapping(value: unknown): MigrationLineageMapping {
  const input = object(value);
  const source = chapter(input.source);
  if (input.decision === "delete-source") {
    if (input.target !== null || input.targetInventory !== null) return invalid("deleted chapter has a target");
    return { source, decision: "delete-source", target: null, targetInventory: null };
  }
  if (input.decision !== "copy-source" && input.decision !== "keep-target") return invalid("chapter decision");
  const target = chapter(input.target);
  if (!source.available || !target.available || !target.complete || source.id === target.id) return invalid("unavailable preserved chapter");
  return { source, decision: input.decision, target, targetInventory: inventory(input.targetInventory) };
}

function decision(value: unknown): MigrationLineageChapterDecision {
  const input = object(value);
  const targetChapterPath = input.targetChapterPath === null ? null : path(input.targetChapterPath);
  const targetChapterNumber = number(input.targetChapterNumber);
  if (targetChapterPath === null && targetChapterNumber !== null) return invalid("deleted chapter has a target number");
  if (input.discardSourceContent !== undefined && (input.discardSourceContent !== true || targetChapterPath === null)) return invalid("source-content discard decision");
  return {
    sourceChapterPath: path(input.sourceChapterPath), sourceChapterNumber: number(input.sourceChapterNumber),
    targetChapterPath, targetChapterNumber,
    ...(input.discardSourceContent === true ? { discardSourceContent: true as const } : {}),
    sourceMetadataVerified: flag(input.sourceMetadataVerified), targetMetadataVerified: flag(input.targetMetadataVerified),
  };
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid("repeated " + label);
}

function indexChapters(chapters: readonly MigrationLineageChapter[]) {
  const paths = new Map<string, MigrationLineageChapter>();
  const numbers = new Map<string, MigrationLineageChapter[]>();
  for (const chapter of chapters) {
    paths.set(chapter.chapterPath, chapter);
    const key = numberKey(chapter.chapterNumber);
    if (key !== null) {
      const matches = numbers.get(key) ?? [];
      matches.push(chapter);
      numbers.set(key, matches);
    }
  }
  return { paths, numbers };
}

function findChapter(chapters: ReturnType<typeof indexChapters>, chapterPath: string, chapterNumber: string | null): MigrationLineageChapter | undefined {
  const exact = chapters.paths.get(chapterPath);
  if (exact) {
    if (chapterNumber !== null && numberKey(exact.chapterNumber) !== numberKey(chapterNumber)) invalid("chapter path and number disagree");
    return exact;
  }
  if (chapterNumber === null) return undefined;
  const matches = chapters.numbers.get(numberKey(chapterNumber)!) ?? [];
  if (matches.length > 1) return invalid("ambiguous chapter number");
  return matches[0];
}

function validateDecisions(lineage: WorkMigrationLineage): void {
  const { mappings, chapterDecisions, sourceWork, targetWork } = lineage;
  if (!lineage.fullDecisionCoverage) {
    if (chapterDecisions.length || mappings.some(value => value.decision === "delete-source")) invalid("incomplete deletion decisions");
    return;
  }
  unique(chapterDecisions.map(value => value.sourceChapterPath), "source decision path");
  unique(chapterDecisions.flatMap(value => value.targetChapterPath === null ? [] : [value.targetChapterPath]), "target decision path");
  const sources = indexChapters(mappings.map(value => value.source));
  const targets = indexChapters(mappings.flatMap(value => value.target ? [value.target] : []));
  const covered = new Set<string>();
  const sourceDecisions = new Map<string, MigrationLineageChapterDecision>();
  for (const value of chapterDecisions) {
    const source = findChapter(sources, value.sourceChapterPath, value.sourceChapterNumber);
    const sourceNumber = numberKey(value.sourceChapterNumber ?? source?.chapterNumber ?? null);
    if (sourceNumber !== null) {
      if (covered.has(sourceNumber)) invalid("repeated source decision number");
      covered.add(sourceNumber);
    }
    if (value.sourceMetadataVerified !== (sourceNumber !== null && Object.hasOwn(sourceWork.metadata.chapters, sourceNumber))) invalid("source metadata verification");
    if (source) {
      if (sourceDecisions.has(source.id)) invalid("repeated source package decision");
      sourceDecisions.set(source.id, value);
    }
    const target = value.targetChapterPath === null ? undefined : findChapter(targets, value.targetChapterPath, value.targetChapterNumber);
    const targetNumber = numberKey(value.targetChapterNumber ?? target?.chapterNumber ?? null);
    if (value.targetChapterPath === null ? value.targetMetadataVerified :
        targetNumber !== null && value.targetMetadataVerified !== Object.hasOwn(targetWork.metadata.chapters, targetNumber)) invalid("target metadata verification");
  }
  if (Object.keys(sourceWork.metadata.chapters).some(value => !covered.has(value))) invalid("source metadata coverage");
  for (const value of mappings) {
    const selected = sourceDecisions.get(value.source.id);
    if (!selected) return invalid("source package has no explicit decision");
    if (value.decision === "delete-source") {
      if (selected.targetChapterPath !== null && !selected.discardSourceContent) invalid("deletion contradicts the selected target");
      if (selected.discardSourceContent && !selected.targetMetadataVerified) invalid("discard target is not in the final metadata");
    } else if (selected.discardSourceContent || selected.targetChapterPath === null ||
        findChapter(targets, selected.targetChapterPath, selected.targetChapterNumber)?.id !== value.target.id) {
      invalid("mapping differs from the selected target");
    }
  }
}

/** Parse the durable server proof before it can suppress imports or move local work. */
export function parseWorkMigrationLineage(raw: unknown): WorkMigrationLineage {
  const input = object(raw);
  const operationId = text(input.operationId, "operation ID", 36);
  if (!UUID.test(operationId)) return invalid("operation ID");
  const sourceWork = work(input.sourceWork);
  const targetWork = work(input.targetWork);
  if (sourceWork.id === targetWork.id || sourceWork.identity.pluginId === targetWork.identity.pluginId) return invalid("source and target work identities");
  const deleted = object(input.deletedSource);
  const deletedSource = { revision: hash(deleted.revision), sequence: sequence(deleted.sequence) };
  if (deletedSource.revision !== sourceWork.revision) return invalid("source retirement revision");
  const mappings = array(input.mappings).map(mapping);
  unique(mappings.map(value => value.source.id), "source package");
  unique(mappings.map(value => value.source.chapterPath), "source package path");
  unique(mappings.flatMap(value => value.target ? [value.target.id] : []), "target package");
  unique(mappings.flatMap(value => value.target ? [value.target.chapterPath] : []), "target package path");
  const parsed: WorkMigrationLineage = {
    sequence: sequence(input.sequence), operationId, sourceWork, targetWork, deletedSource, mappings,
    chapterDecisions: array(input.chapterDecisions).map(decision), fullDecisionCoverage: flag(input.fullDecisionCoverage), active: flag(input.active),
  };
  validateDecisions(parsed);
  return parsed;
}

function parseIncoming(raw: unknown): IncomingMigration {
  const input = object(raw);
  const lineage = parseWorkMigrationLineage(input.lineage);
  if (input.version !== 1 || input.operationId !== lineage.operationId || input.sequence !== lineage.sequence ||
      canonical(input.source) !== canonical(lineage.sourceWork.identity) || canonical(input.target) !== canonical(lineage.targetWork.identity) ||
      typeof input.status !== "string" || !["pending", "failed", "blocked", "completed", "inactive"].includes(input.status) ||
      (input.status === "inactive") !== !lineage.active) return invalid("stored receipt");
  return {
    version: 1, serverUrl: normalizeContentServerUrl(text(input.serverUrl, "server URL")),
    operationId: lineage.operationId, sequence: lineage.sequence,
    source: { ...lineage.sourceWork.identity }, target: { ...lineage.targetWork.identity },
    status: input.status as IncomingMigration["status"], lineage,
    ...(input.error === undefined ? {} : { error: text(input.error, "stored error", 16_384) }),
  };
}

function immutable(lineage: WorkMigrationLineage): string {
  const { sequence: _sequence, active: _active, ...proof } = lineage;
  return canonical(proof);
}

export function incomingMigrationFromLineage(server: string, entry: WorkMigrationLineage, previous?: IncomingMigration): IncomingMigration {
  const serverUrl = normalizeContentServerUrl(server);
  const lineage = parseWorkMigrationLineage(entry);
  const current = previous && parseIncoming(previous);
  if (current && (current.serverUrl !== serverUrl || current.operationId !== lineage.operationId ||
      immutable(current.lineage) !== immutable(lineage))) invalid("immutable lineage changed");
  if (current && lineage.sequence < current.sequence) return current;
  if (current && lineage.sequence === current.sequence && lineage.active !== current.lineage.active) invalid("event state changed without a new sequence");
  return {
    version: 1, serverUrl, operationId: lineage.operationId, sequence: lineage.sequence,
    source: { ...lineage.sourceWork.identity }, target: { ...lineage.targetWork.identity },
    status: !lineage.active ? "inactive" : current && current.status !== "inactive" ? current.status : "pending",
    lineage,
    ...(lineage.active && current?.status !== "inactive" && current?.error ? { error: current.error } : {}),
  };
}

const receiptKey = (server: string, operationId: string) => INCOMING_MIGRATION_CACHE_PREFIX + JSON.stringify([server, operationId]);
const serverReceiptPrefix = (server: string) => INCOMING_MIGRATION_CACHE_PREFIX + JSON.stringify([server]).slice(0, -1) + ",";

function storedIncoming(row: { cacheKey: string; payload: string }): IncomingMigration {
  const parsed = parseIncoming(JSON.parse(row.payload));
  if (row.cacheKey !== receiptKey(parsed.serverUrl, parsed.operationId)) return invalid("receipt cache identity");
  return parsed;
}

export async function listIncomingMigrations(server: string, includeCompleted = false, db?: Database): Promise<IncomingMigration[]> {
  const serverUrl = normalizeContentServerUrl(server);
  const connection = db ?? await getDb();
  const prefix = serverReceiptPrefix(serverUrl);
  const rows = await connection.select<{ cacheKey: string; payload: string }[]>(
    "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE substr(cache_key,1,length($1))=$1 ORDER BY cache_key", [prefix],
  );
  return rows.map(storedIncoming).filter(value => includeCompleted || (value.status !== "completed" && value.status !== "inactive"))
    .sort((left, right) => left.sequence - right.sequence || left.operationId.localeCompare(right.operationId));
}

/** A supplied raw database keeps this receipt in the caller's merge transaction. */
export async function saveIncomingMigration(record: IncomingMigration, db?: Database): Promise<void> {
  const proposed = parseIncoming(record);
  const key = receiptKey(proposed.serverUrl, proposed.operationId);
  const save = async (connection: Database) => {
    const rows = await connection.select<{ cacheKey: string; payload: string }[]>(
      "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE cache_key=$1", [key],
    );
    const previous = rows[0] && storedIncoming(rows[0]);
    const checked = incomingMigrationFromLineage(proposed.serverUrl, proposed.lineage, previous);
    // Never regress a completed merge or a newer revocation when a stale caller settles late.
    const selected = checked.sequence > proposed.sequence || (checked.status === "completed" && proposed.status !== "inactive")
      ? checked : proposed;
    await connection.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
      [key, JSON.stringify(selected)]);
  };
  if (db) await save(db);
  else await runDatabaseTransaction(save);
}

function parseCursor(payload: string, serverUrl: string): number {
  const value = object(JSON.parse(payload));
  if (value.version !== 1 || value.serverUrl !== serverUrl) return invalid("stored cursor");
  return sequence(value.cursor, true);
}

export async function getIncomingMigrationCursor(server: string, db?: Database): Promise<number> {
  const serverUrl = normalizeContentServerUrl(server);
  const connection = db ?? await getDb();
  const rows = await connection.select<{ payload: string }[]>("SELECT payload FROM content_sync_cache WHERE cache_key=$1", [CURSOR_PREFIX + serverUrl]);
  return rows[0] ? parseCursor(rows[0].payload, serverUrl) : 0;
}

export async function saveIncomingMigrationCursor(server: string, cursor: number, db?: Database): Promise<void> {
  const serverUrl = normalizeContentServerUrl(server);
  sequence(cursor, true);
  const save = async (connection: Database) => {
    const previous = await getIncomingMigrationCursor(serverUrl, connection);
    await connection.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
      [CURSOR_PREFIX + serverUrl, JSON.stringify({ version: 1, serverUrl, cursor: Math.max(previous, cursor) })]);
  };
  if (db) await save(db);
  else await runDatabaseTransaction(save);
}
