import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSearchResult } from "../../lib/plugins/global-search";
import type { Plugin } from "../../lib/plugins/types";
import type { SourceAccessConfirmation } from "../../lib/tasks/scheduler";
import type { SourceAccessBlock } from "../../lib/tasks/source-access-gate";

const mocks = vi.hoisted(() => ({ blocks: [] as SourceAccessBlock[] }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { list: () => [] } }));
vi.mock("../../lib/tasks/hooks", () => ({
  useTaskSnapshot: () => ({ sourceAccessBlocks: mocks.blocks }),
}));

import {
  isAccessFailure,
  isCloudflareError,
  retryOnSourceAccessConfirmed,
  SearchFailures,
  sortSourceResults,
  withRetryPluginId,
} from "./BrowseSearchTab";

function plugin(id: string): Plugin {
  return { id, name: `Source ${id}`, lang: "en", version: "1", url: "", iconUrl: "", apiVersion: "0.2", getBaseUrl: () => "https://x" } as Plugin;
}

function result(pluginId: string, count: number): GlobalSearchResult {
  return {
    pluginId,
    pluginName: pluginId,
    novels: Array.from({ length: count }, (_, index) => ({ name: `${index}`, path: `/${index}` })),
  } as GlobalSearchResult;
}

function renderFailures(failures: { error: string; plugin: Plugin }[]) {
  return load(
    renderToStaticMarkup(
      <MantineProvider>
        <SearchFailures
          active
          failures={failures}
          onOpenSite={vi.fn()}
          onRetry={vi.fn()}
          onRetryAll={vi.fn()}
        />
      </MantineProvider>,
    ),
  );
}

const buttonLabels = ($: ReturnType<typeof load>) =>
  $("button").map((_, button) => $(button).attr("aria-label") ?? $(button).text()).get();

describe("withRetryPluginId", () => {
  it("queues only the requested source for retry", () => {
    expect(withRetryPluginId([], "source-b")).toEqual(["source-b"]);
  });

  it("keeps other pending retries when another source is retried", () => {
    expect(withRetryPluginId(["source-a"], "source-b")).toEqual(["source-a", "source-b"]);
  });

  it("keeps the same list when the source is already queued", () => {
    const current = ["source-a"];
    expect(withRetryPluginId(current, "source-a")).toBe(current);
  });
});

describe("retryOnSourceAccessConfirmed", () => {
  function fakeScheduler() {
    const listeners = new Set<(confirmation: SourceAccessConfirmation) => void>();
    return {
      confirm: (confirmation: SourceAccessConfirmation) => {
        for (const listener of listeners) listener(confirmation);
      },
      listenerCount: () => listeners.size,
      subscribeSourceAccessConfirmed: (listener: (confirmation: SourceAccessConfirmation) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  it("retries only an access-failed source once access to it is confirmed", () => {
    const scheduler = fakeScheduler();
    const retry = vi.fn();
    const stop = retryOnSourceAccessConfirmed(scheduler, ["source-a"], retry);

    scheduler.confirm({ revision: 1, scopeKey: "plugin:source-b:site:b.test", sourceId: "source-b" });
    scheduler.confirm({ rangeId: "range-1", revision: 2, scopeKey: "plugin:source-a:site:a.test", sourceId: "source-a" });
    expect(retry).not.toHaveBeenCalled();

    scheduler.confirm({ revision: 3, scopeKey: "plugin:source-a:site:a.test", sourceId: "source-a" });
    expect(retry).toHaveBeenCalledExactlyOnceWith("source-a");

    stop();
    expect(scheduler.listenerCount()).toBe(0);
  });

  it("treats access checks, not ordinary failures, as waiting for verification", () => {
    expect(isAccessFailure({ ...result("a", 0), accessRequired: true, error: "Blocked" })).toBe(true);
    expect(isAccessFailure({ ...result("a", 0), error: "Just a moment..." })).toBe(true);
    expect(isAccessFailure({ ...result("a", 0), error: "HTTP 403" })).toBe(false);
    expect(isAccessFailure(result("a", 0))).toBe(false);
  });
});

describe("isCloudflareError", () => {
  it("recognizes access checks", () => {
    expect(isCloudflareError("Cloudflare verification is required.")).toBe(true);
    expect(isCloudflareError("Complete the CAPTCHA to continue")).toBe(true);
    expect(isCloudflareError("Just a moment...")).toBe(true);
  });

  it("does not treat a plain 403 or Forbidden as an access check", () => {
    expect(isCloudflareError("HTTP 403")).toBe(false);
    expect(isCloudflareError("Request failed: 403 Forbidden")).toBe(false);
    expect(isCloudflareError("forbidden")).toBe(false);
  });
});

describe("sortSourceResults", () => {
  const rows = [
    { plugin: plugin("b"), result: result("b", 5) },
    { plugin: plugin("a"), result: result("a", 1) },
    { plugin: plugin("c"), result: result("c", 9) },
  ];

  it("puts pinned sources first, then the most results", () => {
    expect(sortSourceResults(rows, "pinned", ["a"]).map(({ plugin: p }) => p.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts by source name", () => {
    expect(sortSourceResults(rows, "name", ["c"]).map(({ plugin: p }) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("SearchFailures", () => {
  it("shows one failed source's Retry in place, and Verify only for an access check", () => {
    const plain = renderFailures([{ error: "HTTP 403 Forbidden", plugin: plugin("a") }]);
    expect(buttonLabels(plain)).toEqual(["Retry Source a"]);
    expect(plain("body").text()).toContain("Couldn't search Source a");

    const challenged = renderFailures([{ error: "Cloudflare verification is required.", plugin: plugin("a") }]);
    expect(buttonLabels(challenged)).toEqual(["Retry Source a", "Verify"]);
  });

  it("collapses two or more failures into a chip", () => {
    const $ = renderFailures([
      { error: "boom", plugin: plugin("a") },
      { error: "boom", plugin: plugin("b") },
    ]);
    expect(buttonLabels($)).toEqual(["2 failed"]);
  });
});
