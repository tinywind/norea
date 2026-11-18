import { isNovelStatus, NovelStatus, type NovelStatusValue } from "../plugins/types";
import { isOverrideCoverFileName } from "./schema";

/** User-set work metadata, kept apart from `novel.json` so no source or metadata refresh can change it. */
export interface WorkOverrideField {
  value: string | number | boolean | null;
  /** When the user set this value, in milliseconds; the newer edit wins between devices. */
  updatedAt: number;
}

export interface WorkOverrideIdentity {
  pluginId: string;
  novelId: string;
  novelPath: string;
}

export interface WorkOverrideV1 {
  schemaVersion: 1;
  identity: WorkOverrideIdentity;
  fields: Record<string, WorkOverrideField>;
}

export const WORK_OVERRIDE_EDITABLE_FIELDS = [
  "name",
  "author",
  "artist",
  "summary",
  "genres",
  "status",
  "cover",
] as const;

export const MAX_WORK_OVERRIDE_BYTES = 256 * 1024;
const MAX_FIELDS = 64;
const MAX_TEXT_LENGTH = 8192;
const MAX_SUMMARY_LENGTH = 65536;
const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWellFormedText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length > maxLength) return false;
  const wellFormed = (value as { isWellFormed?: () => boolean }).isWellFormed;
  return typeof wellFormed !== "function" || wellFormed.call(value);
}

function identityText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`Work override ${label} is invalid.`);
  }
  return value;
}

function parseFieldValue(name: string, fieldValue: unknown): WorkOverrideField["value"] {
  if (name === "completed") {
    if (fieldValue !== null && typeof fieldValue !== "boolean") {
      throw new Error(`Work override field '${name}' is invalid.`);
    }
    return fieldValue;
  }
  if (name === "status") {
    if (fieldValue !== null && !isNovelStatus(fieldValue)) {
      throw new Error(`Work override field '${name}' is invalid.`);
    }
    return fieldValue;
  }
  if (name === "cover") {
    if (fieldValue !== null && !isOverrideCoverFileName(fieldValue)) {
      throw new Error(`Work override field '${name}' is invalid.`);
    }
    return fieldValue;
  }
  if (name === "name") {
    if (fieldValue === null) return null;
    if (!isWellFormedText(fieldValue, MAX_TEXT_LENGTH) || !fieldValue.trim()) {
      throw new Error(`Work override field '${name}' is invalid.`);
    }
    return fieldValue.trim();
  }
  if (name === "summary") {
    if (fieldValue !== null && !isWellFormedText(fieldValue, MAX_SUMMARY_LENGTH)) {
      throw new Error(`Work override field '${name}' is invalid.`);
    }
    return fieldValue;
  }
  const validValue = fieldValue === null || typeof fieldValue === "boolean" ||
    (typeof fieldValue === "number" && Number.isFinite(fieldValue)) ||
    isWellFormedText(fieldValue, MAX_TEXT_LENGTH);
  if (!validValue) {
    throw new Error(`Work override field '${name}' is invalid.`);
  }
  return fieldValue as WorkOverrideField["value"];
}

function parseField(name: string, value: unknown): WorkOverrideField {
  if (!FIELD_NAME.test(name) || !isRecord(value) || Object.keys(value).some(key => key !== "value" && key !== "updatedAt")) {
    throw new Error(`Work override field '${name}' is invalid.`);
  }
  const { value: fieldValue, updatedAt } = value;
  if (!Number.isSafeInteger(updatedAt) || (updatedAt as number) <= 0) {
    throw new Error(`Work override field '${name}' is invalid.`);
  }
  return { value: parseFieldValue(name, fieldValue), updatedAt: updatedAt as number };
}

/**
 * Validates a document, upgrades legacy `completed` to canonical `status`,
 * and keeps unknown validly shaped fields verbatim.
 */
export function parseWorkOverride(value: unknown): WorkOverrideV1 {
  if (!isRecord(value) || (value.schemaVersion !== undefined && value.schemaVersion !== 1) ||
      !isRecord(value.identity) || !isRecord(value.fields)) {
    throw new Error("Work override document is invalid.");
  }
  const names = Object.keys(value.fields);
  if (names.length > MAX_FIELDS) throw new Error("Work override has too many fields.");
  const rawFields: Record<string, WorkOverrideField> = {};
  let legacyCompleted: WorkOverrideField | undefined;
  for (const name of names) {
    const parsed = parseField(name, value.fields[name]);
    if (name === "completed") {
      legacyCompleted = {
        value: parsed.value === true ? NovelStatus.Completed : parsed.value === false ? NovelStatus.Ongoing : null,
        updatedAt: parsed.updatedAt,
      };
    } else {
      rawFields[name] = parsed;
    }
  }
  if (legacyCompleted && (!rawFields.status || legacyCompleted.updatedAt > rawFields.status.updatedAt)) {
    rawFields.status = legacyCompleted;
  }
  const fields: Record<string, WorkOverrideField> = {};
  for (const name of Object.keys(rawFields).sort()) fields[name] = rawFields[name]!;
  return {
    schemaVersion: 1,
    identity: {
      pluginId: identityText(value.identity.pluginId, "plugin ID"),
      novelId: identityText(value.identity.novelId, "work ID"),
      novelPath: identityText(value.identity.novelPath, "work path"),
    },
    fields,
  };
}

/** Per field, the strictly newer edit wins and an equal time keeps `base`; the result belongs to `identity`. */
export function mergeWorkOverride(
  base: WorkOverrideV1 | null,
  incoming: WorkOverrideV1 | null,
  identity: WorkOverrideIdentity,
): WorkOverrideV1 {
  const fields: Record<string, WorkOverrideField> = {};
  const names = new Set([...Object.keys(base?.fields ?? {}), ...Object.keys(incoming?.fields ?? {})]);
  for (const name of [...names].sort()) {
    const kept = base?.fields[name];
    const next = incoming?.fields[name];
    fields[name] = kept && (!next || next.updatedAt <= kept.updatedAt) ? kept : next!;
  }
  return { schemaVersion: 1, identity: { ...identity }, fields };
}

export function sameWorkOverrideFields(left: WorkOverrideV1 | null, right: WorkOverrideV1 | null): boolean {
  const leftNames = Object.keys(left?.fields ?? {}).sort();
  const rightNames = Object.keys(right?.fields ?? {}).sort();
  return leftNames.length === rightNames.length && leftNames.every((name, index) => {
    const a = left!.fields[name]!;
    const b = right?.fields[rightNames[index]!];
    return name === rightNames[index] && b !== undefined && a.value === b.value && a.updatedAt === b.updatedAt;
  });
}

/** The canonical publication status set by the user, or null to follow the source status. */
export function statusOverrideOf(override: WorkOverrideV1 | null | undefined): NovelStatusValue | null {
  const status = override?.fields.status?.value;
  if (isNovelStatus(status)) return status;
  const legacy = override?.fields.completed?.value;
  if (legacy === true) return NovelStatus.Completed;
  if (legacy === false) return NovelStatus.Ongoing;
  return null;
}

/** The active `cover.override.<ext>` filename, or null to follow the source cover. */
export function coverOverrideOf(override: WorkOverrideV1 | null | undefined): string | null {
  const value = override?.fields.cover?.value;
  return isOverrideCoverFileName(value) ? value : null;
}

/**
 * Whether a work counts as completed: the user's status override wins, otherwise only
 * the plugin's `NovelStatus.Completed` does. Recognizing a source's completion wording is the plugin's job.
 */
export function isNovelCompleted(novel: { status?: string | null; statusOverride?: string | null }): boolean {
  return (novel.statusOverride ?? novel.status) === NovelStatus.Completed;
}
