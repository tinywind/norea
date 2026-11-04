import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeSettingsSection,
  SETTINGS_SECTION_IDS,
  useSettingsSection,
} from "./use-settings-section";

const router = vi.hoisted(() => ({
  goBackInAppHistory: vi.fn((_href: string) => false),
  href: "/settings?section=about",
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useRouter: () => ({ state: { location: { href: router.href } } }),
}));
vi.mock("./navigation-history", () => ({ goBackInAppHistory: router.goBackInAppHistory }));

let root: Root | undefined;
let current: ReturnType<typeof useSettingsSection>;

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

function Probe({ section, stacked }: { section?: string; stacked: boolean }) {
  current = useSettingsSection(section, stacked);
  return null;
}

async function render(section?: string, stacked = false) {
  await act(async () => root!.render(<Probe section={section} stacked={stacked} />));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.clearAllMocks();
  router.goBackInAppHistory.mockReturnValue(false);
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

it("adds a history entry for a stacked section and goes back to where it was opened from", async () => {
  mount();
  await render(undefined, true);
  current[1]("about");
  expect(router.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "about" }, replace: false });

  router.navigate.mockClear();
  router.goBackInAppHistory.mockReturnValue(true);
  await render("about", true);
  current[2]();
  expect(router.goBackInAppHistory).toHaveBeenCalledWith("/settings?section=about");
  expect(router.navigate).not.toHaveBeenCalled();
});

it("opens the section index for missing or unknown sections", async () => {
  mount();
  await render(undefined);
  expect(current[0]).toBeNull();
  await render("unknown");
  expect(current[0]).toBeNull();
  await render("Reader");
  expect(current[0]).toBe("reader");

  current[2]();
  expect(router.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: undefined }, replace: true });
});

it("keeps every section id and maps the ids of earlier builds to their new sections", () => {
  for (const id of SETTINGS_SECTION_IDS) expect(normalizeSettingsSection(id)).toBe(id);
  expect(normalizeSettingsSection("app")).toBe("appearance");
  expect(normalizeSettingsSection("data")).toBe("backup");
  expect(normalizeSettingsSection(" DATA ")).toBe("backup");
  expect(normalizeSettingsSection("")).toBeNull();
});
