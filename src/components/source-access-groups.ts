import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";

export interface SourceAccessBannerGroup {
  key: string;
  blocks: SourceAccessBlock[];
}

function displayGroupKey(block: SourceAccessBlock): string {
  const scopeKey = `scope:${block.scopeKey}`;
  if (block.rangeId !== undefined || block.challenge.kind !== "forbidden") return scopeKey;
  try {
    const url = new URL(block.challenge.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return scopeKey;
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return `ordinary:forbidden:${url.origin}`;
  } catch {
    return scopeKey;
  }
}

/**
 * Groups only the visible warning. Each original block keeps its own plugin,
 * revision and recovery actions; VPN ranges are never merged with other scopes.
 */
export function groupSourceAccessBanners(
  blocks: readonly SourceAccessBlock[],
): SourceAccessBannerGroup[] {
  const groups = new Map<string, SourceAccessBannerGroup>();
  for (const block of blocks) {
    const key = displayGroupKey(block);
    const existing = groups.get(key);
    if (existing) existing.blocks.push(block);
    else groups.set(key, { key, blocks: [block] });
  }
  return [...groups.values()];
}
