export interface ChapterTitleIdentity {
  displayNumber: string | null;
  displayKey: string | null;
  exactTitle: string | null;
  scope: string;
  remainingNumbers: string;
  uncertain: boolean;
}

const DISPLAY_NUMBER_PATTERNS = [
  /^(?:第|제)?\s*(\d+(?:\.\d+)?)\s*(?:話|话|章|回|화|장|회)/gu,
  /\b(?:chapter|chap|ch|episode|ep)\.?\s*(\d+(?:\.\d+)?)/gu,
  /(?:第|제)?\s*(\d+(?:\.\d+)?)\s*(?:話|话|章|回|화|장|회)(?![\p{L}\p{N}])/gu,
  /(?:외전|번외|番外|外伝|外傳|특별편|특별화)\s*[-:#]?\s*(\d+(?:\.\d+)?)/gu,
  /\b(?:side[\s-]*story|extra|special)\s*[-:#]?\s*(\d+(?:\.\d+)?)/gu,
];

const SCOPE_NUMBER_PATTERNS = [
  [/\bseason\s*(\d+)/gu, /시즌\s*(\d+)/gu, /(\d+)\s*시즌/gu],
  [/\bpart\s*(\d+)/gu, /(?:제)?\s*(\d+)\s*부/gu],
  [/\bvol(?:ume)?\.?\s*(\d+)/gu, /(?:제)?\s*(\d+)\s*권/gu],
];

const CHAPTER_KINDS = [
  ["side", /외전|번외|番外|外伝|外傳|\bside[\s-]*stor(?:y|ies)\b/u],
  ["special", /특별편|특별화|스페셜|\b(?:extra|special)(?:s)?\b/u],
  ["prologue", /프롤로그|\bprologue\b/u],
  ["epilogue", /에필로그|\bepilogue\b/u],
  ["notice", /공지|작가의\s*말|후기|\b(?:notice|afterword|author['’]?s?\s*note)\b/u],
] as const;

function takeLabelNumbers(
  title: string,
  patterns: readonly RegExp[],
): { numbers: string[]; remaining: string } {
  const numbers = new Set<string>();
  let remaining = title;
  for (const pattern of patterns) {
    remaining = remaining.replace(pattern, (_match, value: string) => {
      numbers.add(String(Number(value)));
      return " ";
    });
  }
  return { numbers: [...numbers], remaining };
}

/** Parse title labels without treating a provider's stored ID as an episode. */
export function parseChapterTitle(name: string): ChapterTitleIdentity {
  const title = name.normalize("NFKC").toLowerCase();
  // Token boundaries retain decimal numbers and distinguish e.g. "Room 12"
  // from "Room 1-2"; the fuzzy title helper deliberately does not do that.
  const exactTitle = title.match(/[\p{L}\p{M}]+|\d+(?:\.\d+)?/gu)?.join(" ") || null;
  const kinds = CHAPTER_KINDS.filter(([, pattern]) => pattern.test(title));
  let uncertain = kinds.length > 1;
  let remaining = title;
  const scopeNumbers: (string | null)[] = [];
  for (const patterns of SCOPE_NUMBER_PATTERNS) {
    const taken = takeLabelNumbers(remaining, patterns);
    uncertain ||= taken.numbers.length > 1;
    scopeNumbers.push(taken.numbers[0] ?? null);
    remaining = taken.remaining;
  }
  const taken = takeLabelNumbers(remaining, DISPLAY_NUMBER_PATTERNS);
  const numericRemainder = taken.remaining.trim().match(/^#?\s*(\d+(?:\.\d+)?)\.?$/u)?.[1];
  const bareNumber = taken.numbers.length === 0 ? numericRemainder : undefined;
  const numbers = bareNumber === undefined ? taken.numbers : [String(Number(bareNumber))];
  uncertain ||= numbers.length > 1;
  const displayNumber = numbers.length === 1 ? numbers[0]! : null;
  uncertain ||= numericRemainder !== undefined && displayNumber !== String(Number(numericRemainder));
  const scope = JSON.stringify([kinds[0]?.[0] ?? "main", ...scopeNumbers]);
  return {
    displayNumber,
    displayKey: displayNumber === null || uncertain ? null : JSON.stringify([scope, displayNumber]),
    exactTitle,
    scope,
    // Some providers repeat a bare numeric title after their episode label,
    // such as "278화 278". Only that exact repetition is redundant.
    remainingNumbers: numericRemainder !== undefined && String(Number(numericRemainder)) === displayNumber
      ? ""
      : (taken.remaining.match(/\d+(?:\.\d+)?/gu) ?? []).map(Number).join(","),
    uncertain,
  };
}

/** A clear title episode for reader-facing labels; ambiguous titles stay unset. */
export function displayedChapterNumber(name: string | null | undefined): string | null {
  if (!name) return null;
  const title = parseChapterTitle(name);
  return title.uncertain ? null : title.displayNumber;
}
