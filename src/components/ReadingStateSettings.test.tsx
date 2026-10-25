import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  savedKey: "a".repeat(64), draft: undefined as string | undefined,
  stateIndex: 0, setState: vi.fn(), sync: vi.fn(), saveKey: vi.fn(), invalidate: vi.fn(), copy: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: vi.fn(), useRef: () => ({ current: null }),
  useState: (initial: unknown) => {
    const value = typeof initial === "function" ? initial() : initial;
    return [mocks.stateIndex++ === 1 && mocks.draft !== undefined ? mocks.draft : value, mocks.setState];
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("../lib/content-sync/reading-state", () => ({
  readReadingSyncKey: () => mocks.savedKey,
  createReadingSyncKey: () => "b".repeat(64),
  validReadingSyncKey: (key: string) => /^[a-f0-9]{64}$/.test(key),
  saveReadingSyncKey: mocks.saveKey,
  syncReadingState: mocks.sync,
  ReadingSyncError: class extends Error {},
}));

import { ReadingStateSettings } from "./ReadingStateSettings";
interface Props { children?: ReactNode; onClick?: () => void; disabled?: boolean }
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...controls(element.props.children)];
}
function button(label: string) {
  return controls(ReadingStateSettings({ serverUrl: "http://server" })).find(item => item.props.children === label)!;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.stateIndex = 0; mocks.savedKey = "a".repeat(64); mocks.draft = undefined;
  mocks.saveKey.mockImplementation((_server, key) => key);
  mocks.sync.mockResolvedValue({ uploaded: 0, downloaded: 1, serverUpdated: 0, localUpdated: 1, skipped: 0 });
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.copy.mockResolvedValue(undefined);
});

it.each(["pull", "push", "merge"])("exposes the explicit %s action and invalidates local views after imports", async mode => {
  const action = button(`readingSync.${mode}`);
  expect(action.props.disabled).toBe(false);
  action.props.onClick!();
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledWith("http://server", mocks.savedKey, mode, expect.any(Function), expect.any(AbortSignal)));
  if (mode === "push") expect(mocks.invalidate).not.toHaveBeenCalled();
  else {
    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(3));
    expect(mocks.invalidate.mock.calls.map(call => call[0])).toEqual([
      { queryKey: ["novel"] }, { queryKey: ["chapter"] }, { queryKey: ["category"] },
    ]);
  }
});

it("requires saving an edited private key before any transfer", () => {
  mocks.draft = "c".repeat(64);
  const elements = controls(ReadingStateSettings({ serverUrl: "http://server" }));
  for (const mode of ["pull", "push", "merge"]) {
    expect(elements.find(item => item.props.children === `readingSync.${mode}`)!.props.disabled).toBe(true);
  }
  elements.find(item => item.props.children === "readingSync.saveKey")!.props.onClick!();
  expect(mocks.saveKey).toHaveBeenCalledWith("http://server", mocks.draft);
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("creates a private key only after the user chooses it, without starting a transfer", () => {
  mocks.savedKey = "";
  button("readingSync.createKey").props.onClick!();
  expect(mocks.saveKey).toHaveBeenCalledWith("http://server", "b".repeat(64));
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("uses the WebView-compatible clipboard helper before showing copy success", async () => {
  button("readingSync.copyKey").props.onClick!();
  await vi.waitFor(() => expect(mocks.setState).toHaveBeenCalledWith("readingSync.keyCopied"));
  expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(mocks.savedKey);
});

it("offers manual-copy guidance instead of success when both clipboard methods fail", async () => {
  mocks.copy.mockRejectedValue(new Error("Clipboard rejected"));
  button("readingSync.copyKey").props.onClick!();
  await vi.waitFor(() => expect(mocks.setState).toHaveBeenCalledWith("readingSync.copyFailed"));
  expect(mocks.setState).not.toHaveBeenCalledWith("readingSync.keyCopied");
});
