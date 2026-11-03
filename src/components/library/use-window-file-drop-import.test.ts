import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { importDroppedFiles } from "./use-window-file-drop-import";

const file = (name: string, type = "") => new File(["x"], name, { type });

function drop(files: File[]) {
  const handlers = { notifyUnsupported: vi.fn(), openLibrary: vi.fn(), queue: vi.fn() };
  importDroppedFiles(files, handlers);
  return handlers;
}

describe("importDroppedFiles", () => {
  it("queues supported files for the import review and opens the Library", () => {
    const epub = file("book.epub");
    const text = file("notes.TXT");
    const handlers = drop([epub, text]);
    expect(handlers.queue).toHaveBeenCalledWith([epub, text]);
    expect(handlers.openLibrary).toHaveBeenCalledTimes(1);
    expect(handlers.notifyUnsupported).not.toHaveBeenCalled();
  });

  it("reports unsupported files and still queues the supported ones", () => {
    const pdf = file("scan.pdf");
    const zip = file("archive.zip", "application/zip");
    const handlers = drop([pdf, zip]);
    expect(handlers.queue).toHaveBeenCalledWith([pdf]);
    expect(handlers.notifyUnsupported).toHaveBeenCalledWith([zip]);
  });

  it("stays on the current page when nothing dropped can be imported", () => {
    const handlers = drop([file("photo.png", "image/png")]);
    expect(handlers.queue).not.toHaveBeenCalled();
    expect(handlers.openLibrary).not.toHaveBeenCalled();
    expect(handlers.notifyUnsupported).toHaveBeenCalledTimes(1);
  });

  it("accepts a supported MIME type without a known extension", () => {
    const handlers = drop([file("chapter", "text/markdown")]);
    expect(handlers.queue).toHaveBeenCalledTimes(1);
  });
});

it("lets the main window's WebView receive dropped files", () => {
  const config = JSON.parse(readFileSync(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
    app: { windows: Array<{ dragDropEnabled?: boolean; label: string }> };
  };
  expect(config.app.windows.find((window) => window.label === "main")?.dragDropEnabled).toBe(false);
});
