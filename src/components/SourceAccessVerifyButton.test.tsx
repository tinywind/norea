import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";

const mocks = vi.hoisted(() => ({
  blocks: [] as SourceAccessBlock[],
  canVerify: true,
  canVerifyByScope: new Map<string, boolean>(),
}));

vi.mock("../lib/tasks/hooks", () => ({
  useTaskSnapshot: () => ({ sourceAccessBlocks: mocks.blocks }),
}));
vi.mock("../lib/tasks/scheduler", () => ({
  taskScheduler: {
    canOpenSourceAccessBrowser: (scopeKey: string) => mocks.canVerifyByScope.get(scopeKey) ?? mocks.canVerify,
  },
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

function hostBlock(host: string, overrides: Partial<SourceAccessBlock> = {}): SourceAccessBlock {
  return {
    ...BLOCK,
    challenge: { kind: "forbidden", url: `https://${host}` },
    scopeKey: `plugin:source-a:site:${host}`,
    ...overrides,
  };
}

describe("SourceAccessNotice", () => {
  afterEach(() => {
    mocks.blocks = [];
    mocks.canVerify = true;
    mocks.canVerifyByScope.clear();
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
    expect($(".norea-source-access-banner").text()).not.toContain("Start a download or open the source before verifying");
    expect($('button[aria-label="Verify Source A"]').attr("disabled")).toBeDefined();
  });

  it("uses the ordinary challenge instead of an older VPN range challenge for the same source", () => {
    const vpn: SourceAccessBlock = {
      ...BLOCK,
      challenge: { kind: "captcha", url: "https://source.test" },
      rangeId: "vpn-range",
      workerGeneration: 1,
      scopeKey: `${BLOCK.scopeKey}:range:vpn-range`,
      verificationRequested: true,
    };
    const ordinary = hostBlock("source.test", { detectedAt: 5, revision: 5 });
    mocks.blocks = [vpn, ordinary];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner").attr("data-source-access")).toBe(ordinary.scopeKey);
    expect($(".norea-source-access-banner").text()).toContain("HTTP 403");
    expect($('button[aria-label="Verify Source A"]').attr("disabled")).toBeUndefined();
  });

  it("prefers a verifiable host over a newer unavailable challenge", () => {
    const unavailable = hostBlock("previous.test", {
      challenge: { kind: "captcha", url: "https://previous.test" },
      detectedAt: 20,
      revision: 8,
    });
    const current = hostBlock("current.test", { detectedAt: 10, revision: 5 });
    mocks.canVerify = false;
    mocks.canVerifyByScope.set(current.scopeKey, true);
    mocks.blocks = [unavailable, current];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner").attr("data-source-access")).toBe(current.scopeKey);
    expect($(".norea-source-access-banner").text()).toContain("(HTTP 403) · current.test");
    expect($('button[aria-label="Verify Source A"]').attr("disabled")).toBeUndefined();
  });

  it("keeps an in-flight verification selected", () => {
    const verificationState = { verificationTaskId: "verification-task" };
    const verifying = hostBlock("verifying.test", verificationState);
    const available = hostBlock("available.test", { detectedAt: 20, revision: 8 });
    mocks.canVerify = false;
    mocks.canVerifyByScope.set(available.scopeKey, true);
    mocks.blocks = [available, verifying];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner").attr("data-source-access")).toBe(verifying.scopeKey);
    expect($('button[aria-label="Verify Source A"]').attr("disabled")).toBeDefined();
    expect($(".norea-source-access-banner").text()).not.toContain("Start a download or open the source before verifying");
  });

  it("keeps a pending verification selected and lets the site be reopened", () => {
    const waiting = hostBlock("waiting.test", { verificationRequested: true, detectedAt: 20, revision: 8 });
    const available = hostBlock("available.test");
    mocks.blocks = [available, waiting];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner").attr("data-source-access")).toBe(waiting.scopeKey);
    expect($('button[aria-label="Verify Source A"]').attr("disabled")).toBeUndefined();
    expect($(".norea-source-access-banner").text()).toContain("Access will be checked the next time you browse or download from this source.");
  });

  it("does not let an old next-request confirmation hide a newer challenged hostname", () => {
    const waiting = hostBlock("previous.test", { verificationRequested: true });
    const current = hostBlock("current.test", { detectedAt: 20, revision: 8 });
    mocks.blocks = [waiting, current];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner").attr("data-source-access")).toBe(current.scopeKey);
    expect($('button[aria-label="Verify Source A"]').attr("disabled")).toBeUndefined();
  });

  it("falls back to the latest unavailable ordinary challenge with revision breaking timestamp ties", () => {
    const older = hostBlock("older.test", { detectedAt: 5, revision: 9 });
    const sameTime = hostBlock("same-time.test", { detectedAt: 10, revision: 4 });
    const latest = hostBlock("latest.test", { detectedAt: 10, revision: 5 });
    mocks.canVerify = false;
    mocks.blocks = [older, latest, sameTime];
    const orderBeforeRender = mocks.blocks.map(block => block.scopeKey);
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner").attr("data-source-access")).toBe(latest.scopeKey);
    expect($('button[aria-label="Verify Source A"]').attr("disabled")).toBeDefined();
    expect($(".norea-source-access-banner").text()).not.toContain("Start a download or open the source before verifying");
    expect(mocks.blocks.map(block => block.scopeKey)).toEqual(orderBeforeRender);
  });

  it("hides source-level recovery when only VPN ranges match the source", () => {
    mocks.blocks = [
      { ...BLOCK, rangeId: "vpn-range", workerGeneration: 1, scopeKey: `${BLOCK.scopeKey}:range:vpn-range` },
      { ...BLOCK, sourceId: "source-b", scopeKey: "plugin:source-b:site:source.test" },
    ];
    const $ = render(<SourceAccessNotice active sourceId="source-a" sourceName="Source A" />);

    expect($(".norea-source-access-banner")).toHaveLength(0);
  });

});
