import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBodyFlag } from "./use-body-flag";

let root: Root;
let attributes: Map<string, string>;

function Flag({ active }: { active: boolean }) {
  useBodyFlag("selection-bar", active);
  return null;
}

async function render(flags: boolean[]) {
  await act(async () => root.render(<>{flags.map((active, index) => <Flag active={active} key={index} />)}</>));
}

beforeEach(() => {
  attributes = new Map();
  const document = {
    nodeType: 9, activeElement: null, body: null as unknown,
    documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {},
  };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Node", class {});
  root = createRoot(container as unknown as Element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("useBodyFlag", () => {
  it("sets the body attribute while a caller is active and clears it after", async () => {
    await render([false]);
    expect(attributes.has("data-norea-selection-bar")).toBe(false);

    await render([true]);
    expect(attributes.get("data-norea-selection-bar")).toBe("true");

    await render([false]);
    expect(attributes.has("data-norea-selection-bar")).toBe(false);
  });

  it("keeps the attribute until the last active caller lets go", async () => {
    await render([true, true]);
    await render([true, false]);
    expect(attributes.get("data-norea-selection-bar")).toBe("true");

    await render([false, false]);
    expect(attributes.has("data-norea-selection-bar")).toBe(false);
  });
});
