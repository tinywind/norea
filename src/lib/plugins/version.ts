const SEMVER_LIKE = /^v?(\d+(?:\.\d+)*)(?:-([0-9a-z.-]+))?(?:\+[0-9a-z.-]+)?$/i;

interface ParsedVersion {
  release: number[];
  prerelease: string[];
}

export type PluginVersionComparison = "newer" | "same" | "different";

function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER_LIKE.exec(version.trim());
  if (!match) return null;
  return {
    release: match[1]!.split(".").map(Number),
    prerelease: match[2] ? match[2].split(".") : [],
  };
}

function compareReleases(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semver precedence: a release outranks its prereleases. */
function comparePrereleases(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return Math.sign(right.length - left.length);
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const difference = comparePrereleaseIdentifier(left[index]!, right[index]!);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * How a repository version relates to the installed one. Versions follow
 * semver precedence, with any number of dot-separated release parts (missing
 * parts count as 0), an optional leading "v" and build metadata ignored.
 * When neither side is semver-like, the trimmed strings are compared with
 * numeric awareness. When only one side is, the versions cannot be ordered
 * and read as "different", so a malformed index entry never claims an update.
 */
export function comparePluginVersions(
  candidate: string,
  current: string,
): PluginVersionComparison {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  let order: number;
  if (next && installed) {
    order =
      compareReleases(next.release, installed.release) ||
      comparePrereleases(next.prerelease, installed.prerelease);
  } else if (!next && !installed && candidate.trim() !== "" && current.trim() !== "") {
    order = Math.sign(
      candidate.trim().localeCompare(current.trim(), "en", { numeric: true }),
    );
  } else {
    return candidate.trim() === current.trim() ? "same" : "different";
  }
  return order > 0 ? "newer" : order === 0 ? "same" : "different";
}

/** Whether `candidate` is a strictly newer plugin version than `current`. */
export function isNewerPluginVersion(candidate: string, current: string): boolean {
  return comparePluginVersions(candidate, current) === "newer";
}
