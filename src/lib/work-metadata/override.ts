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

export const MAX_WORK_OVERRIDE_BYTES = 256 * 1024;
const MAX_FIELDS = 64;
const MAX_TEXT_LENGTH = 8192;
const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identityText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`Work override ${label} is invalid.`);
  }
  return value;
}

function parseField(name: string, value: unknown): WorkOverrideField {
  if (!FIELD_NAME.test(name) || !isRecord(value) || Object.keys(value).some(key => key !== "value" && key !== "updatedAt")) {
    throw new Error(`Work override field '${name}' is invalid.`);
  }
  const { value: fieldValue, updatedAt } = value;
  const validValue = fieldValue === null || typeof fieldValue === "boolean" ||
    (typeof fieldValue === "number" && Number.isFinite(fieldValue)) ||
    (typeof fieldValue === "string" && fieldValue.length <= MAX_TEXT_LENGTH);
  if (!validValue || !Number.isSafeInteger(updatedAt) || (updatedAt as number) <= 0 ||
      (name === "completed" && fieldValue !== null && typeof fieldValue !== "boolean")) {
    throw new Error(`Work override field '${name}' is invalid.`);
  }
  return { value: fieldValue as WorkOverrideField["value"], updatedAt: updatedAt as number };
}

/** Validates a document and keeps every validly shaped field, including names this version does not know. */
export function parseWorkOverride(value: unknown): WorkOverrideV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.identity) || !isRecord(value.fields)) {
    throw new Error("Work override document is invalid.");
  }
  const names = Object.keys(value.fields);
  if (names.length > MAX_FIELDS) throw new Error("Work override has too many fields.");
  const fields: Record<string, WorkOverrideField> = {};
  for (const name of names.sort()) fields[name] = parseField(name, value.fields[name]);
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

/** The manual completion flag: true or false when the user set it, null to follow the source status. */
export function completedOverrideOf(override: WorkOverrideV1 | null | undefined): boolean | null {
  const value = override?.fields.completed?.value;
  return typeof value === "boolean" ? value : null;
}

const COMPLETED_SOURCE_STATUS = /complete|finished|완결|完結|完结/i;

/** Whether a work counts as completed: the user's flag wins, otherwise the source status text decides. */
export function isNovelCompleted(novel: { status?: string | null; completedOverride?: boolean | null }): boolean {
  return novel.completedOverride ?? COMPLETED_SOURCE_STATUS.test(novel.status ?? "");
}
