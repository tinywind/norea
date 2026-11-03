import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

import { useReaderChrome } from "./use-reader-chrome";

type Chrome = ReturnType<typeof useReaderChrome>;
type ChromeOptions = Parameters<typeof useReaderChrome>[0];

let chrome: Chrome;
let root: Root;

function Probe(props: ChromeOptions) {
  chrome = useReaderChrome(props);
  return null;
}

const baseOptions: ChromeOptions = {
  active: true,
  chapterId: 11,
  fullPageReader: true,
  showSeekbar: true,
  readerStateVisible: false,
};

async function render(options: Partial<ChromeOptions> = {}) {
  await act(async () => root.render(<Probe {...baseOptions} {...options} />));
}

async function run(callback: () => void) {
  await act(async () => callback());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const document = {
    nodeType: 9, activeElement: null, body: null as unknown,
    documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {},
  };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    document,
    HTMLIFrameElement: class {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: number) => clearTimeout(id),
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as Element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reader chrome contract", () => {
  it("keeps the chrome visible in normal mode and a center tap does not hide it", async () => {
    await render({ fullPageReader: false });
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => chrome.handleReaderMenuTap());
    expect(chrome.readerChromeVisible).toBe(true);
  });

  it("starts hidden in full-page mode and toggles with the center tap", async () => {
    await render();
    expect(chrome.readerChromeVisible).toBe(false);
    await run(() => chrome.handleReaderMenuTap());
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => chrome.handleReaderMenuTap());
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("hides full-page chrome after five idle seconds and activity restarts the wait", async () => {
    await render();
    await run(() => chrome.handleReaderMenuTap());
    await run(() => vi.advanceTimersByTime(4000));
    await run(() => chrome.handleReaderActivity());
    await run(() => vi.advanceTimersByTime(4000));
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => vi.advanceTimersByTime(1000));
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("hides full-page chrome again when the chapter changes", async () => {
    await render();
    await run(() => chrome.handleReaderMenuTap());
    await render({ chapterId: 12 });
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("shows full-page chrome while a loading or error state covers the content", async () => {
    await render({ readerStateVisible: true });
    expect(chrome.readerChromeVisible).toBe(true);
  });

  it("opens settings with the chrome shown and closes them on request", async () => {
    await render();
    await run(() => chrome.openReaderSettingsPanel());
    expect(chrome.readerSettingsOpen).toBe(true);
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => chrome.closeReaderSettingsPanel());
    expect(chrome.readerSettingsOpen).toBe(false);
  });
});
