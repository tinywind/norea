import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";
import type { IconButton } from "./IconButton";
import type { OverflowMenu } from "./ui/OverflowMenu";

const mocks = vi.hoisted(() => ({
  eligible: new Set<string>(),
  browserVisible: false,
  open: vi.fn(),
  apply: vi.fn(),
  cancel: vi.fn(),
  buttons: [] as Parameters<typeof IconButton>[0][],
  menus: [] as Parameters<typeof OverflowMenu>[0][],
}));
vi.mock("../lib/tasks/scheduler", () => ({
  taskScheduler: { canBeginSourceAccessVerification: (scopeKey: string) => mocks.eligible.has(scopeKey) },
}));
vi.mock("../lib/tasks/source-access-coordinator", () => ({
  openSourceAccessBrowser: mocks.open,
  applySourceAccessBrowserOutcome: mocks.apply,
  cancelSourceAccessWait: mocks.cancel,
}));
vi.mock("../store/site-browser", () => ({
  useSiteBrowserStore: (select: (state: { visible: boolean }) => unknown) => select({ visible: mocks.browserVisible }),
}));
vi.mock("./IconButton", async importOriginal => {
  const actual = await importOriginal<typeof import("./IconButton")>();
  return { ...actual, IconButton: (props: Parameters<typeof actual.IconButton>[0]) => {
    mocks.buttons.push(props);
    return <actual.IconButton {...props} />;
  } };
});
vi.mock("./ui/OverflowMenu", async importOriginal => {
  const actual = await importOriginal<typeof import("./ui/OverflowMenu")>();
  return { ...actual, OverflowMenu: (props: Parameters<typeof actual.OverflowMenu>[0]) => {
    mocks.menus.push(props);
    return <actual.OverflowMenu {...props} />;
  } };
});

import { taskScheduler } from "../lib/tasks/scheduler";
import { SourceAccessBannerGroup } from "./SourceAccessBanner";

const A: SourceAccessBlock = {
  challenge: { kind: "forbidden", url: "https://source.test/first" },
  detectedAt: 1, revision: 3, sourceId: "source-a",
  scopeKey: "plugin:source-a:site:source.test", verificationRequested: false,
};
const B: SourceAccessBlock = {
  ...A, challenge: { kind: "forbidden", url: "https://source.test/second" },
  detectedAt: 2, revision: 5, sourceId: "source-b", scopeKey: "plugin:source-b:site:source.test",
};

function render(blocks: SourceAccessBlock[] = [A, B], names = ["Source A", "Source B"]) {
  return load(renderToStaticMarkup(
    <MantineProvider>
      <SourceAccessBannerGroup entries={blocks.map((block, index) => ({ block, sourceNames: [names[index]] }))} />
    </MantineProvider>,
  ));
}

function options() {
  return mocks.menus.find(menu => menu.label === "More options for Source A, Source B")!.items;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eligible.clear();
  mocks.browserVisible = false;
  mocks.buttons = [];
  mocks.menus = [];
});

describe("grouped source access recovery", () => {
  it("shows both affected sources once and keeps verification disabled without a queued candidate", () => {
    const $ = render();
    expect($(".norea-source-access-banner")).toHaveLength(1);
    expect($("h3")).toHaveLength(1);
    expect($.text()).toContain("Sources: Source A, Source B");
    expect($("p").filter((_, element) => $(element).text().includes("Start a download or open the source before verifying"))).toHaveLength(1);
    expect($('button[aria-label="Verify Source A, Source B"]').attr("disabled")).toBeDefined();
    expect(options().filter(item => !item.danger).every(item => item.disabled)).toBe(true);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("directly verifies the only eligible source instead of the first displayed scope", () => {
    mocks.eligible.add(B.scopeKey);
    render();
    const button = mocks.buttons.find(item => item.label === "Verify Source B")!;
    expect(button.disabled).toBe(false);
    button.onClick?.({} as never);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(B, expect.objectContaining({ sourceName: "Source B" }));
    expect(mocks.menus.some(menu => menu.label === "Choose a source to verify")).toBe(false);
  });

  it("requires an explicit source choice when both scopes can be verified", () => {
    mocks.eligible.add(A.scopeKey);
    mocks.eligible.add(B.scopeKey);
    render();
    const choices = mocks.menus.find(menu => menu.label === "Choose a source to verify")!.items;
    expect(choices.map(item => item.label)).toEqual(["Verify Source A", "Verify Source B"]);
    expect(mocks.open).not.toHaveBeenCalled();
    choices[1].onClick();
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(B, expect.objectContaining({ sourceName: "Source B" }));
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("keeps resume and skip source-specific, passing the original block and revision", () => {
    mocks.eligible.add(B.scopeKey);
    render();
    const menu = options();
    expect(menu).toHaveLength(4);
    const resumeA = menu.find(item => item.label.startsWith("Source A · ") && !item.danger)!;
    const resumeB = menu.find(item => item.label.startsWith("Source B · ") && !item.danger)!;
    expect(resumeA.disabled).toBe(true);
    expect(resumeB.disabled).toBe(false);
    resumeB.onClick();
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(taskScheduler, B, "verify");
    menu.find(item => item.label.startsWith("Source A · ") && item.danger)!.onClick();
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(A.scopeKey, A.revision);
  });

  it.each([1, 2])("disables %i eligible source controls while the verification browser is visible", count => {
    mocks.eligible.add(A.scopeKey);
    if (count === 2) mocks.eligible.add(B.scopeKey);
    mocks.browserVisible = true;
    const $ = render();
    const primary = count === 1 ? "Verify Source A" : "Choose a source to verify";
    expect(mocks.buttons.find(button => button.label === primary)?.disabled).toBe(true);
    expect(options().filter(item => !item.danger).every(item => item.disabled)).toBe(true);
    expect(options().filter(item => item.danger).every(item => !item.disabled)).toBe(true);
    expect($.text()).not.toContain("Start a download or open the source before verifying");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    { verificationRequested: true },
    { verificationTaskId: "verification-task" },
  ])("keeps in-flight progress and eligibility scoped to their own source: %j", state => {
    mocks.eligible.add(A.scopeKey);
    mocks.eligible.add(B.scopeKey);
    const verifyingB = { ...B, ...state };
    const $ = render([A, verifyingB]);
    expect($.text()).toContain("Verifying: Source B");
    expect(mocks.buttons.find(button => button.label === "Verify Source A")?.disabled).toBe(false);
    expect(options().find(item => item.label.startsWith("Source B · ") && !item.danger)?.disabled).toBe(true);
    expect($.text()).not.toContain("Start a download or open the source before verifying");
  });

  it("identifies each source's error without discarding another member's failure", () => {
    const $ = render([{ ...A, verificationError: "first failure" }, { ...B, verificationError: "second failure" }]);
    const errors = $("p").map((_, element) => $(element).text()).get();
    expect(errors.some(text => text.includes("Source A") && text.includes("first failure"))).toBe(true);
    expect(errors.some(text => text.includes("Source B") && text.includes("second failure"))).toBe(true);
  });

  it("disambiguates equal display names before choosing an authentication scope", () => {
    mocks.eligible.add(A.scopeKey);
    mocks.eligible.add(B.scopeKey);
    render([A, B], ["Newtoki", "Newtoki"]);
    const choices = mocks.menus.find(menu => menu.label === "Choose a source to verify")!.items;
    expect(choices.map(item => item.label)).toEqual(["Verify Newtoki (source-a)", "Verify Newtoki (source-b)"]);
    choices[0].onClick();
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(A, expect.objectContaining({ sourceName: "Newtoki (source-a)" }));
  });
});
