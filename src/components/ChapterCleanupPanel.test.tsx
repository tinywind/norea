import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@mantine/core", async () => {
  const React = await import("react");
  const wrap = (tag: string) => ({ children }: { children?: React.ReactNode }) => React.createElement(tag, null, children);
  return {
    Modal: ({ opened, children }: { opened: boolean; children: React.ReactNode }) => opened ? React.createElement("section", null, children) : null,
    Alert: wrap("aside"), Group: wrap("div"), Stack: wrap("div"), Text: wrap("span"),
    Select: ({ label, data, value }: { label: string; data: { value: string; label: string }[]; value: string }) =>
      React.createElement("label", null, label, React.createElement("select", { value, readOnly: true }, data.map(item => React.createElement("option", { key: item.value, value: item.value }, item.label)))),
    MultiSelect: wrap("div"),
    Button: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => React.createElement("button", { disabled }, children),
  };
});
vi.mock("../lib/tasks/chapter-cleanup", () => ({ enqueueChapterCleanup: vi.fn() }));
vi.mock("../lib/chapter-cleanup", () => ({ previewChapterCleanup: vi.fn() }));
vi.mock("../db/queries/category", () => ({ listCategories: vi.fn(), UNCATEGORIZED_CATEGORY_ID: -1 }));

import { ChapterCleanupPanel } from "./ChapterCleanupPanel";

describe("ChapterCleanupPanel", () => {
  it("shows the four server choices, reading and category filters before any preview", () => {
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><ChapterCleanupPanel opened onClose={() => {}} /></QueryClientProvider>);
    expect(html).toContain("Present on server");
    expect(html).toContain("Server coverage at least device coverage");
    expect(html).toContain("Server contains all device content");
    expect(html).toContain("Ignore server state");
    expect(html).toContain("Read chapters");
    expect(html).toContain("All chapters");
    expect(html).toContain("Selected categories");
    expect(html).toContain("Conditions:");
    expect(html).toContain("Preview");
    expect(html).not.toContain("Delete downloaded files");
    expect(html).not.toContain("Delete from server");
  });
});
