export interface ChapterPayloadDigest {
  sha256: string;
  bytes: number;
}

export interface ChapterPayloadInventory {
  body: ChapterPayloadDigest | null;
  expectedAssetKeys: string[] | null;
  storedAssets: (ChapterPayloadDigest & { key: string })[];
}

export interface ChapterPayloadSnapshot extends ChapterPayloadInventory {
  fingerprint: string;
  payloadBytes: number;
  contentBytes: number;
  mediaBytes: number;
  mediaComplete: boolean;
}

type ComparisonReason = "invalid-inventory" | "missing-body" | "different-body" | "missing-declarations" | "different-declarations";

export interface ChapterInventoryComparison {
  coverageEligible: boolean;
  containsLocal: boolean;
  coverageReason: ComparisonReason | null;
  containmentReason: ComparisonReason | null;
}

function validDigest(value: ChapterPayloadDigest): boolean {
  return typeof value?.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
}

function validKey(key: unknown): key is string {
  return typeof key === "string" && /^media\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(key)
    && !key.toLowerCase().endsWith(".part") && key.length <= 261;
}

export function isChapterPayloadInventory(value: unknown): value is ChapterPayloadInventory {
  if (!value || typeof value !== "object") return false;
  const inventory = value as ChapterPayloadInventory;
  if ((inventory.body !== null && !validDigest(inventory.body)) || !Array.isArray(inventory.storedAssets) || inventory.storedAssets.length > 100_000) return false;
  const keys = inventory.expectedAssetKeys;
  if (keys !== null && (!Array.isArray(keys) || keys.length > 100_000 || keys.some((key) => !validKey(key)))) return false;
  const declared = keys === null ? null : new Set(keys);
  if (declared && (declared.size !== keys!.length || new Set(keys!.map((key) => key.toLowerCase())).size !== keys!.length)) return false;
  const seen = new Set<string>();
  for (const asset of inventory.storedAssets) {
    if (!asset || !validKey(asset.key) || seen.has(asset.key.toLowerCase()) || !validDigest(asset)) return false;
    seen.add(asset.key.toLowerCase());
  }
  return true;
}

export function compareChapterInventories(local: ChapterPayloadInventory, remote: ChapterPayloadInventory): ChapterInventoryComparison {
  const failed = (reason: ComparisonReason): ChapterInventoryComparison => ({ coverageEligible: false, containsLocal: false, coverageReason: reason, containmentReason: reason });
  if (!isChapterPayloadInventory(local) || !isChapterPayloadInventory(remote)) return failed("invalid-inventory");
  if (!local.body || !remote.body) return failed("missing-body");
  if (local.body.sha256 !== remote.body.sha256 || local.body.bytes !== remote.body.bytes) return failed("different-body");
  if (local.expectedAssetKeys === null || remote.expectedAssetKeys === null) return failed("missing-declarations");
  const remoteAssets = new Map(remote.storedAssets.map((asset) => [asset.key, asset]));
  const containsLocal = local.storedAssets.every((asset) => {
    const match = remoteAssets.get(asset.key);
    return match?.sha256 === asset.sha256 && match.bytes === asset.bytes;
  });
  const remoteKeys = new Set(remote.expectedAssetKeys);
  if (local.expectedAssetKeys.length !== remoteKeys.size || local.expectedAssetKeys.some((key) => !remoteKeys.has(key))) {
    return { coverageEligible: false, containsLocal, coverageReason: "different-declarations", containmentReason: null };
  }
  const localCount = local.storedAssets.filter((asset) => remoteKeys.has(asset.key)).length;
  const remoteCount = remote.storedAssets.filter((asset) => remoteKeys.has(asset.key)).length;
  const coverageEligible = local.expectedAssetKeys.length === 0 || remoteCount >= localCount;
  return { coverageEligible, containsLocal, coverageReason: null, containmentReason: null };
}
