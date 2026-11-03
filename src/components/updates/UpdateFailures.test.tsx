import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheckFailure } from "../../lib/updates/check-library-updates";

const mocks = vi.hoisted(() => ({
  blocks: [] as unknown[],
}));

vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}${JSON.stringify(values)}` : key,
  }),
}));
vi.mock("../../lib/tasks/hooks", () => ({
  useTaskSnapshot: () => ({ sourceAccessBlocks: mocks.blocks }),
}));
vi.mock("../../lib/tasks/scheduler", () => ({
  taskScheduler: { canBeginSourceAccessVerification: () => true },
}));
vi.mock("../../lib/tasks/source-access-coordinator", () => ({
  openSourceAccessBrowser: vi.fn(),
}));
vi.mock("../../store/site-browser", () => ({
  useSiteBrowserStore: (selector: (state: { visible: boolean }) => unknown) =>
    selector({ visible: false }),
}));

import { groupFailuresBySource, UpdateFailures } from "./UpdateFailures";

const failure = (
  novelId: number,
  pluginId: string,
  reason: UpdateCheckFailure["reason"] = { kind: "error", message: "HTTP 503" },
): UpdateCheckFailure => ({
  novelId,
  novelName: `Novel ${novelId}`,
  pluginId,
  pluginName: `Source ${pluginId}`,
  reason,
});

function render(failures: UpdateCheckFailure[]) {
  return load(
    renderToStaticMarkup(
      <MantineProvider>
        <UpdateFailures
          active
          onOpenNovel={vi.fn()}
          onRetry={vi.fn()}
          sources={groupFailuresBySource(failures)}
        />
      </MantineProvider>,
    ),
  );
}

const buttonLabels = ($: ReturnType<typeof load>) =>
  $("button").toArray().map((button) => $(button).text());

beforeEach(() => {
  mocks.blocks = [];
});

it("groups failed novels by source in arrival order", () => {
  const sources = groupFailuresBySource([
    failure(1, "a"),
    failure(2, "b", { kind: "plugin-missing", pluginId: "b" }),
    failure(3, "a"),
  ]);
  expect(sources.map((source) => [source.pluginId, source.failures.length, source.pluginMissing])).toEqual([
    ["a", 2, false],
    ["b", 1, true],
  ]);
});

describe("UpdateFailures", () => {
  it("shows one failed source in place with Retry and Details", () => {
    const $ = render([failure(1, "a"), failure(2, "a")]);
    expect($('[role="status"]').text()).toContain('updates.failure.oneSource{"name":"Source a"}');
    expect(buttonLabels($)).toEqual(["common.retry", "common.details"]);
  });

  it("offers Verify when the failed source is waiting on a challenge", () => {
    mocks.blocks = [{
      challenge: { kind: "cloudflare", url: "https://a.example" },
      scopeKey: "a",
      sourceId: "a",
      verificationRequested: false,
    }];
    const $ = render([failure(1, "a")]);
    expect(buttonLabels($)).toEqual(["updates.failure.verify", "common.details"]);
    expect($.text()).toContain("updates.failure.verification");
  });

  it("opens the novel directly when its one failure is a missing plugin", () => {
    const $ = render([failure(1, "a", { kind: "plugin-missing", pluginId: "a" })]);
    expect(buttonLabels($)).toEqual(["updates.openNovelAction", "common.details"]);
  });

  it("collapses more than one failed source into a chip", () => {
    const $ = render([failure(1, "a"), failure(2, "b")]);
    expect($('[role="status"]')).toHaveLength(0);
    expect(buttonLabels($)).toEqual(['updates.failure.chip{"count":2}']);
  });

  it("renders nothing without failures", () => {
    expect(render([])("button, section")).toHaveLength(0);
  });
});
