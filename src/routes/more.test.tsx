import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const taskAttention = vi.hoisted(() => ({ count: 0 }));
const library = vi.hoisted(() => ({
  incognitoMode: false,
  setIncognitoMode: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    to,
  }: {
    children?: ReactNode;
    search?: Record<string, string | undefined>;
    to: string;
  }) => {
    const query = new URLSearchParams(
      Object.entries(search ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ).toString();
    return <a href={query ? `${to}?${query}` : to}>{children}</a>;
  },
}));
vi.mock("../lib/tasks/hooks", () => ({
  useTaskAttentionCount: () => taskAttention.count,
}));
vi.mock("../store/library", () => ({
  useLibraryStore: <T,>(select: (state: typeof library) => T) => select(library),
}));

import { MorePage } from "./more";

function renderMorePage(): string {
  return renderToStaticMarkup(
    <MantineProvider>
      <MorePage />
    </MantineProvider>,
  );
}

function linkHrefs(markup: string): string[] {
  return [...markup.matchAll(/<a href="([^"]*)">/g)].map(([, href]) => href);
}

describe("More page", () => {
  afterEach(() => {
    taskAttention.count = 0;
    library.incognitoMode = false;
  });

  it("links every destination that left the primary navigation", () => {
    const markup = renderMorePage();

    expect(linkHrefs(markup)).toEqual([
      "/downloads?view=queue",
      "/settings",
      "/settings?section=about",
    ]);
    expect(markup).toContain("Downloads");
    expect(markup).not.toContain("Download cache");
    expect(markup).toContain("Settings");
    expect(markup).toContain("About");
  });

  it("badges Downloads with active and failed tasks", () => {
    taskAttention.count = 4;
    const markup = renderMorePage();

    expect(markup).toContain('<span class="norea-more-row-badge">4</span>');
    expect(markup.match(/norea-more-row-badge/g)).toHaveLength(1);
  });

  it("shows no badge when no task needs attention", () => {
    expect(renderMorePage()).not.toContain("norea-more-row-badge");
  });

  it("owns the pause reading history switch", () => {
    const switchState = () =>
      renderMorePage().match(
        /<input data-checked="(true|false)"[^>]*role="switch"/,
      )?.[1];

    expect(renderMorePage()).toContain("Pause reading history");
    expect(switchState()).toBe("false");

    library.incognitoMode = true;

    expect(switchState()).toBe("true");
  });
});
