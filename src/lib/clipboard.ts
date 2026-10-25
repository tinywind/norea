/** Copy from a user action, including WebViews that deny the async clipboard API. */
export async function copyTextToClipboard(value: string): Promise<void> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Android WebViews can reject writeText even during a direct button click.
  }

  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") {
    throw new Error("Clipboard copying is unavailable.");
  }
  const active = document.activeElement as HTMLElement | null;
  const control = active as HTMLInputElement | HTMLTextAreaElement | null;
  const inputSelection = control && typeof control.selectionStart === "number" && typeof control.selectionEnd === "number"
    ? { start: control.selectionStart, end: control.selectionEnd, direction: control.selectionDirection }
    : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px";
  try {
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    if (!document.execCommand("copy")) throw new Error("Clipboard copying was rejected.");
  } finally {
    textarea.value = "";
    textarea.remove();
    try {
      selection?.removeAllRanges();
      for (const range of ranges) selection?.addRange(range);
    } catch {
      // The original selection may have been removed by a concurrent render.
    }
    if (active?.isConnected) {
      try {
        active.focus({ preventScroll: true });
        if (inputSelection) control?.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
      } catch {
        // A removed or changed input cannot have its old selection restored.
      }
    }
  }
}
