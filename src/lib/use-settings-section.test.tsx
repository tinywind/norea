import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeSettingsSection,
  SETTINGS_SECTION_IDS,
  useSettingsSection,
  type SettingsSectionId,
} from "./use-settings-section";

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => router.navigate }));

let root: Root | undefined;
let current: readonly [SettingsSectionId | null, (id: SettingsSectionId | null) => void];

function mount() {
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
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as Element);
}

function Probe({ section }: { section?: string }) {
  current = useSettingsSection(section);
  return null;
}

async function render(section?: string) {
  await act(async () => root!.render(<Probe section={section} />));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("writes a selected section to the route so reopening the reader section applies again", async () => {
  mount();
  await render("reader");
  expect(current[0]).toBe("reader");

  current[1]("library");
  expect(router.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "library" }, replace: true });

  await render("library");
  expect(current[0]).toBe("library");
  await render("reader");
  expect(current[0]).toBe("reader");
});

it("opens the section index for missing or unknown sections", async () => {
  mount();
  await render(undefined);
  expect(current[0]).toBeNull();
  await render("unknown");
  expect(current[0]).toBeNull();
  await render("Reader");
  expect(current[0]).toBe("reader");

  current[1](null);
  expect(router.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: undefined }, replace: true });
});

it("keeps every section id and maps the ids of earlier builds to their new sections", () => {
  for (const id of SETTINGS_SECTION_IDS) expect(normalizeSettingsSection(id)).toBe(id);
  expect(normalizeSettingsSection("app")).toBe("appearance");
  expect(normalizeSettingsSection("data")).toBe("backup");
  expect(normalizeSettingsSection(" DATA ")).toBe("backup");
  expect(normalizeSettingsSection("")).toBeNull();
});
