import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openReaderLink } from "./reader-links";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

function link(href: string) {
  return { getAttribute: () => href } as unknown as HTMLAnchorElement;
}

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { href: "http://tauri.localhost/reader?chapterId=1", origin: "http://tauri.localhost" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(openUrl).mockClear();
});

it("opens web and mail links outside the app", () => {
  openReaderLink(link("https://example.com/notes"));
  openReaderLink(link("mailto:author@example.com"));
  expect(vi.mocked(openUrl).mock.calls).toEqual([
    ["https://example.com/notes"],
    ["mailto:author@example.com"],
  ]);
});

it("ignores links that resolve inside the app or use other schemes", () => {
  openReaderLink(link("/chapter/2"));
  openReaderLink(link("#note-1"));
  openReaderLink(link("javascript:alert(1)"));
  expect(openUrl).not.toHaveBeenCalled();
});
