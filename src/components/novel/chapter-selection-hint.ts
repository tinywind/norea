/** Device-local flag; it is not a backup setting. */
export const CHAPTER_SELECTION_HINT_KEY = "chapter-selection-hint-seen";

/**
 * Returns true the first time chapter selection opens on this device and
 * records that the hint was shown. Without storage the hint stays hidden,
 * so it never repeats on every selection.
 */
export function takeChapterSelectionHint(): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage || storage.getItem(CHAPTER_SELECTION_HINT_KEY) !== null) return false;
    storage.setItem(CHAPTER_SELECTION_HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
