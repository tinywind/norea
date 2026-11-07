import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";

const mocks = vi.hoisted(() => ({ blocks: [] as SourceAccessBlock[] }));

vi.mock("../lib/tasks/hooks", () => ({
  useTaskSnapshot: () => ({ sourceAccessBlocks: mocks.blocks }),
}));
vi.mock("../lib/tasks/scheduler", () => ({
  taskScheduler: { canBeginSourceAccessVerification: () => true },
}));
vi.mock("../lib/tasks/source-access-coordinator", () => ({
  openSourceAccessBrowser: vi.fn(),
}));

import { BlockingLoadingOverlay } from "./AppFrame";
import { SourceAccessNotice } from "./SourceAccessVerifyButton";

const BLOCK: SourceAccessBlock = {
  challenge: { kind: "cloudflare", url: "https://source.test" },
  detectedAt: 1,
  revision: 1,
  scopeKey: "plugin:source-a:site:source.test",
  sourceId: "source-a",
  verificationRequested: false,
};

function render(node: ReactNode) {
  return load(renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>));
}

describe("SourceAccessNotice", () => {
  afterEach(() => {
    mocks.blocks = [];
  });

  it("stays out of the way while the source has no access check", () => {
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-notice")).toHaveLength(0);
  });

  it("offers Verify in place for a held source and says the work continues by itself", () => {
    mocks.blocks = [BLOCK];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-notice").text()).toContain("Source A needs verification");
    expect($(".norea-source-access-notice").text()).toContain("continues by itself");
    expect($(".norea-source-access-notice button").text()).toBe("Verify");
  });

  it("ignores another source's check and a surface that is not waiting", () => {
    mocks.blocks = [BLOCK];

    expect(render(<SourceAccessNotice active sourceId="source-b" sourceName="B" />)(
      ".norea-source-access-notice",
    )).toHaveLength(0);
    expect(render(
      <SourceAccessNotice active enabled={false} sourceId="source-a" sourceName="Source A" />,
    )(".norea-source-access-notice")).toHaveLength(0);
  });

  it("shows Verify inside the opening overlay so the held open can continue", () => {
    mocks.blocks = [BLOCK];
    const $ = render(
      <BlockingLoadingOverlay cancelLabel="Cancel" label="Opening" onCancel={vi.fn()}>
        <SourceAccessNotice active sourceId="source-a" sourceName="Source A" />
      </BlockingLoadingOverlay>,
    );

    expect($(".norea-blocking-loading-panel .norea-source-access-notice button").text()).toBe(
      "Verify",
    );
    expect($(".norea-blocking-loading-panel").text()).toContain("Cancel");
  });

  it("identifies an access refusal as HTTP 403 in the held-source notice", () => {
    mocks.blocks = [{ ...BLOCK, challenge: { kind: "forbidden", url: "https://source.test/chapter" } }];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);
    const text = $(".norea-source-access-notice").text();
    expect(text).toContain("HTTP 403");
    expect(text).toContain("Downloads are paused");
    expect(text).not.toContain("Cloudflare");
  });

});
