import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const taskAttention = vi.hoisted(() => ({ count: 0 }));
const pluginUpdates = vi.hoisted(() => ({ count: 0 }));
const library = vi.hoisted(() => ({
  incognitoMode: false,
  setIncognitoMode: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    state,
    to,
  }: {
    children?: ReactNode;
    search?: Record<string, string | undefined>;
    state?: unknown;
    to: string;
  }) => {
    const query = new URLSearchParams(
      Object.entries(search ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ).toString();
    return (
      <a data-state={JSON.stringify(state)} href={query ? `${to}?${query}` : to}>
        {children}
      </a>
    );
  },
}));
vi.mock("../lib/tasks/hooks", () => ({
  useTaskAttentionCount: () => taskAttention.count,
}));
vi.mock("../components/browse/use-plugin-catalog", () => ({
  usePluginUpdateCount: () => pluginUpdates.count,
}));
vi.mock("../store/library", () => ({
  useLibraryStore: <T,>(select: (state: typeof library) => T) => select(library),
}));

import { isOpenedFromMore } from "../lib/navigation-history";
import { MorePage } from "./more";

function renderMorePage(): string {
  return renderToStaticMarkup(
    <MantineProvider>
      <MorePage />
    </MantineProvider>,
  );
}

function linkHrefs(markup: string): string[] {
  return [...markup.matchAll(/<a [^>]*href="([^"]*)">/g)].map(([, href]) => href);
}

describe("More page", () => {
  afterEach(() => {
    taskAttention.count = 0;
    pluginUpdates.count = 0;
    library.incognitoMode = false;
  });

  it("links every destination that left the primary navigation", () => {
    const markup = renderMorePage();

    expect(linkHrefs(markup)).toEqual([
      "/downloads?view=queue",
      "/browse/extensions",
      "/settings",
      "/settings?section=about",
    ]);
    expect(markup).toContain("Downloads");
    expect(markup).not.toContain("Download cache");
    expect(markup).toContain("Settings");
    expect(markup).toContain("About");
  });

  it("marks every destination as opened from More so the primary nav keeps More current", () => {
    const states = [...renderMorePage().matchAll(/<a data-state="([^"]*)"/g)].map(([, state]) =>
      JSON.parse(state.replaceAll("&quot;", '"')) as unknown,
    );

    expect(states).toHaveLength(4);
    for (const state of states) expect(isOpenedFromMore(state)).toBe(true);
  });

  it("badges Downloads with active and failed tasks", () => {
    taskAttention.count = 4;
    const markup = renderMorePage();

    expect(markup).toContain('<span class="norea-more-row-badge">4</span>');
    expect(markup.match(/norea-more-row-badge/g)).toHaveLength(1);
  });

  it("badges Extensions with the plugin update count", () => {
    pluginUpdates.count = 3;
    const markup = renderMorePage();

    expect(markup).toContain("Extensions");
    expect(markup).toMatch(/Extensions<\/span><\/span><span class="norea-more-row-badge">3<\/span>/);
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

  it("names the page for screen readers only and shows no bar or back button", () => {
    const markup = renderMorePage();

    expect(markup).toMatch(/<h1 class="[^"]*mantine-VisuallyHidden-root[^"]*">More<\/h1>/);
    expect(markup).not.toContain("norea-app-bar");
    expect(markup).not.toContain('aria-label="Back"');
  });
});
