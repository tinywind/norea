const NUMERIC_VERSION = /^v?(\d+(?:\.\d+)*)$/i;

function versionParts(version: string): number[] | null {
  const match = NUMERIC_VERSION.exec(version.trim());
  return match ? match[1]!.split(".").map(Number) : null;
}

/**
 * Whether `candidate` is a strictly newer plugin version than `current`.
 * Versions are dot-separated numbers with an optional leading "v"; missing
 * parts count as 0. Anything else is not comparable and never newer, so a
 * malformed index entry cannot claim an update.
 */
export function isNewerPluginVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  if (!next || !installed) return false;
  const length = Math.max(next.length, installed.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (next[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
