import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

const secret = "a".repeat(64);
let copied: string | null;
let textarea: {
  value: string; readOnly: boolean; tabIndex: number; style: { cssText: string };
  setAttribute: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn>;
  setSelectionRange: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>;
};
let focused: { isConnected: boolean; selectionStart: number; selectionEnd: number; selectionDirection: string;
  focus: ReturnType<typeof vi.fn>; setSelectionRange: ReturnType<typeof vi.fn> };
let selection: { rangeCount: number; getRangeAt: ReturnType<typeof vi.fn>; removeAllRanges: ReturnType<typeof vi.fn>; addRange: ReturnType<typeof vi.fn> };
let documentMock: { body: { appendChild: ReturnType<typeof vi.fn> }; activeElement: typeof focused;
  getSelection: ReturnType<typeof vi.fn>; createElement: ReturnType<typeof vi.fn>; execCommand: ReturnType<typeof vi.fn> };
const savedRange = { startOffset: 2, endOffset: 4 };

beforeEach(() => {
  copied = null;
  textarea = { value: "", readOnly: false, tabIndex: 0, style: { cssText: "" }, setAttribute: vi.fn(),
    focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() };
  focused = { isConnected: true, selectionStart: 2, selectionEnd: 5, selectionDirection: "backward",
    focus: vi.fn(), setSelectionRange: vi.fn() };
  selection = { rangeCount: 1, getRangeAt: vi.fn(() => ({ cloneRange: () => savedRange })), removeAllRanges: vi.fn(), addRange: vi.fn() };
  documentMock = { body: { appendChild: vi.fn() }, activeElement: focused,
    getSelection: vi.fn(() => selection), createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => { copied = textarea.value; return true; }) };
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => vi.unstubAllGlobals());

it("uses the async clipboard when allowed without changing focus or selection", async () => {
  await copyTextToClipboard(secret);
  expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(secret);
  expect(documentMock.createElement).not.toHaveBeenCalled();
  expect(focused.focus).not.toHaveBeenCalled();
});

it("copies the exact key after WebView permission rejection and restores the original selections", async () => {
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error("Write permission denied."));
  await copyTextToClipboard(secret);
  expect(copied).toBe(secret);
  expect(documentMock.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
  expect(textarea.readOnly).toBe(true);
  expect(textarea.select).toHaveBeenCalledOnce();
  expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, secret.length);
  expect(textarea.value).toBe("");
  expect(textarea.remove).toHaveBeenCalledOnce();
  expect(selection.removeAllRanges).toHaveBeenCalledOnce();
  expect(selection.addRange).toHaveBeenCalledWith(savedRange);
  expect(focused.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(focused.setSelectionRange).toHaveBeenCalledWith(2, 5, "backward");
});

it("falls back when the async clipboard API is absent", async () => {
  vi.stubGlobal("navigator", {});
  await copyTextToClipboard(secret);
  expect(copied).toBe(secret);
  expect(textarea.remove).toHaveBeenCalledOnce();
});

it.each(["false", "throw"])("reports fallback failure (%s), cleans up secret text and still restores focus", async failure => {
  vi.stubGlobal("navigator", {});
  documentMock.execCommand.mockImplementation(() => {
    if (failure === "throw") throw new Error("Copy failed");
    return false;
  });
  await expect(copyTextToClipboard(secret)).rejects.toThrow();
  expect(copied).toBeNull();
  expect(textarea.value).toBe("");
  expect(textarea.remove).toHaveBeenCalledOnce();
  expect(focused.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(selection.addRange).toHaveBeenCalledWith(savedRange);
});

it("does not restore focus to an input removed during copying", async () => {
  vi.stubGlobal("navigator", {});
  documentMock.execCommand.mockImplementation(() => { focused.isConnected = false; copied = textarea.value; return true; });
  await copyTextToClipboard(secret);
  expect(copied).toBe(secret);
  expect(focused.focus).not.toHaveBeenCalled();
  expect(textarea.remove).toHaveBeenCalledOnce();
});
