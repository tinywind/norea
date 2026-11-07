import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";

const mocks = vi.hoisted(() => ({ blocks: [] as SourceAccessBlock[], canVerify: true }));

vi.mock("../lib/tasks/hooks", () => ({
  useTaskSnapshot: () => ({ sourceAccessBlocks: mocks.blocks }),
}));
vi.mock("../lib/tasks/scheduler", () => ({
  taskScheduler: { canBeginSourceAccessVerification: () => mocks.canVerify },
}));
vi.mock("../lib/tasks/source-access-coordinator", () => ({
  openSourceAccessBrowser: vi.fn(),
  applySourceAccessBrowserOutcome: vi.fn(),
  cancelSourceAccessWait: vi.fn(),
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
    mocks.canVerify = true;
  });

  it("stays out of the way while the source has no access check", () => {
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner")).toHaveLength(0);
  });

  it("reuses the queue warning with direct verification for a held source", () => {
    mocks.blocks = [BLOCK];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner").text()).toContain("Complete Cloudflare verification · source.test");
    expect($(".norea-source-access-banner").text()).toContain("Downloads and browsing for Source A are paused until verification succeeds");
    expect($(".norea-source-access-banner button").first().attr("aria-label")).toBe("Verify Source A");
  });

  it("ignores another source's check and a surface that is not waiting", () => {
    mocks.blocks = [BLOCK];

    expect(render(<SourceAccessNotice active sourceId="source-b" sourceName="B" />)(
      ".norea-source-access-banner",
    )).toHaveLength(0);
    expect(render(
      <SourceAccessNotice active enabled={false} sourceId="source-a" sourceName="Source A" />,
    )(".norea-source-access-banner")).toHaveLength(0);
  });

  it("shows Verify inside the opening overlay so the held open can continue", () => {
    mocks.blocks = [BLOCK];
    const $ = render(
      <BlockingLoadingOverlay cancelLabel="Cancel" label="Opening" onCancel={vi.fn()}>
        <SourceAccessNotice active sourceId="source-a" sourceName="Source A" />
      </BlockingLoadingOverlay>,
    );

    expect($(".norea-blocking-loading-panel .norea-source-access-banner button").first().attr("aria-label")).toBe(
      "Verify Source A",
    );
    expect($(".norea-blocking-loading-panel").text()).toContain("Cancel");
  });

  it("identifies an access refusal as HTTP 403 in the held-source notice", () => {
    mocks.blocks = [{ ...BLOCK, challenge: { kind: "forbidden", url: "https://source.test/chapter" } }];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);
    const text = $(".norea-source-access-banner").text();
    expect(text).toContain("HTTP 403");
    expect(text).toContain("Downloads are paused");
    expect(text).not.toContain("Cloudflare");
  });

  it("keeps verification failures visible and disables unavailable verification", () => {
    mocks.canVerify = false;
    mocks.blocks = [{ ...BLOCK, verificationError: "HTTP 403 from source.test" }];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);
    expect($(".norea-source-access-banner").text()).toContain("HTTP 403 from source.test");
    expect($(".norea-source-access-banner").text()).toContain("Start a download or open the source before verifying");
    expect($('button[aria-label="Verify Source A"]').attr("disabled")).toBeDefined();
  });

});
