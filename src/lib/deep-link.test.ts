import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}));

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { parseDeepLink, startDeepLinkListener } from "./deep-link";

const getCurrentMock = vi.mocked(getCurrent);
const onOpenUrlMock = vi.mocked(onOpenUrl);

beforeEach(() => {
  getCurrentMock.mockReset().mockResolvedValue(null);
  onOpenUrlMock.mockReset().mockResolvedValue(vi.fn());
});

describe("parseDeepLink", () => {
  it("parses norea://repo/add?url=<...> as repo-add", () => {
    const result = parseDeepLink(
      "norea://repo/add?url=https%3A%2F%2Fexample.test%2Fp.json",
    );
    expect(result).toEqual({
      kind: "repo-add",
      repoUrl: "https://example.test/p.json",
    });
  });

  it("trims surrounding whitespace in the url query param", () => {
    const result = parseDeepLink(
      "norea://repo/add?url=%20https%3A%2F%2Fexample.test%2Fp.json%20",
    );
    expect(result).toEqual({
      kind: "repo-add",
      repoUrl: "https://example.test/p.json",
    });
  });

  it("parses norea://settings/backup as the backup settings target", () => {
    expect(parseDeepLink("norea://settings/backup")).toEqual({
      kind: "task-notification", action: { type: "openBackupSettings" },
    });
    for (const raw of ["norea://settings/backup?x=1", "norea://settings/network", "norea://settings"]) {
      expect(parseDeepLink(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  it("returns unknown when the url query param is missing", () => {
    const raw = "norea://repo/add";
    expect(parseDeepLink(raw)).toEqual({ kind: "unknown", raw });
  });

  it("returns unknown when the url query param is empty", () => {
    const raw = "norea://repo/add?url=";
    expect(parseDeepLink(raw)).toEqual({ kind: "unknown", raw });
  });

  it("returns unknown when the repository URL is not a web address", () => {
    for (const repoUrl of ["javascript%3Aalert(1)", "file%3A%2F%2F%2Fetc%2Fpasswd", "plugins.json"]) {
      const raw = `norea://repo/add?url=${repoUrl}`;
      expect(parseDeepLink(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  it("returns unknown for non-matching paths under repo", () => {
    const raw = "norea://repo/wrong?url=https://example.test/p.json";
    expect(parseDeepLink(raw)).toEqual({ kind: "unknown", raw });
  });

  it("returns unknown for the wrong scheme", () => {
    const raw = "https://repo/add?url=https://example.test/p.json";
    expect(parseDeepLink(raw)).toEqual({ kind: "unknown", raw });
  });

  it("returns unknown for unparseable input", () => {
    const raw = "not a url";
    expect(parseDeepLink(raw)).toEqual({ kind: "unknown", raw });
  });

  it("opens tasks from a durable notification body link", () => {
    expect(parseDeepLink("norea://tasks")).toEqual({
      kind: "task-notification", action: { type: "openTasks" },
    });
  });

  it("decodes the exact source scope and revision without accepting a target URL", () => {
    expect(parseDeepLink("norea://tasks?action=verifySource&sourceId=source-a&scopeKey=plugin%3Asource-a%3Asite%3Ahttps%3A%2F%2Fsource.test%2F%3Fa%3D1%26b%3Dtwo+words&revision=7")).toEqual({
      kind: "task-notification",
      action: { type: "verifySource", sourceId: "source-a", scopeKey: "plugin:source-a:site:https://source.test/?a=1&b=two words", revision: 7 },
    });
  });

  it.each([
    "norea://tasks?action=pause&groupKey=downloads",
    "norea://tasks?url=https://untrusted.example/",
    "norea://tasks?action=verifySource&sourceId=source-a&scopeKey=scope&revision=0",
    "norea://tasks?action=verifySource&sourceId=source-a&scopeKey=scope&revision=1.5",
    "norea://tasks?action=verifySource&sourceId=source-a&scopeKey=scope&revision=9007199254740992",
    "norea://tasks?action=verifySource&sourceId=%20&scopeKey=scope&revision=7",
    "norea://tasks?action=verifySource&sourceId=source-a&scopeKey=scope&revision=7&sourceId=other",
    "norea://tasks/other",
    "norea://user@tasks",
    "norea://tasks#code",
    "norea://updates/other",
    "norea://updates?url=https://untrusted.example/",
    "norea://novel",
    "norea://novel/0",
    "norea://novel/03",
    "norea://novel/1.5",
    "norea://novel/9007199254740992",
    "norea://novel/3/chapter",
    "norea://novel/3/chapter/0",
    "norea://novel/3/chapter/9/extra",
    "norea://novel/3?chapterId=9",
    "norea://novel/3#top",
    "norea://user@novel/3",
  ])("rejects malformed or unsupported notification link %s", raw => {
    expect(parseDeepLink(raw)).toEqual({ kind: "unknown", raw });
  });

  it.each([
    ["norea://updates", { type: "openUpdates" }],
    ["norea://attention", { type: "openAttention" }],
    ["norea://novel/3", { type: "openNovel", novelId: 3 }],
    ["norea://novel/3/chapter/9", { type: "openChapter", novelId: 3, chapterId: 9 }],
  ])("opens the notification target %s", (raw, action) => {
    expect(parseDeepLink(raw)).toEqual({ kind: "task-notification", action });
  });
});

describe("startDeepLinkListener", () => {
  it("subscribes before reading the cold-start task link", async () => {
    const onAction = vi.fn();
    const unlisten = vi.fn();
    onOpenUrlMock.mockResolvedValue(unlisten);
    getCurrentMock.mockResolvedValue(["norea://tasks"]);

    const cleanup = await startDeepLinkListener({ onRepoAdd: vi.fn(), onTaskNotificationAction: onAction });

    expect(onOpenUrlMock.mock.invocationCallOrder[0]).toBeLessThan(getCurrentMock.mock.invocationCallOrder[0]);
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: "openTasks" });
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("delivers a startup URL once when the live event overlaps the current snapshot", async () => {
    let receive!: (urls: string[]) => void;
    let resolveCurrent!: (urls: string[] | null) => void;
    onOpenUrlMock.mockImplementation(async handler => { receive = handler; return vi.fn<() => void>(); });
    getCurrentMock.mockImplementation(() => new Promise(resolve => { resolveCurrent = resolve; }));
    const onAction = vi.fn();
    const starting = startDeepLinkListener({ onRepoAdd: vi.fn(), onTaskNotificationAction: onAction });
    await vi.waitFor(() => expect(getCurrentMock).toHaveBeenCalledOnce());

    receive(["norea://tasks"]);
    resolveCurrent(["norea://tasks"]);
    const cleanup = await starting;

    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: "openTasks" });
    cleanup();
  });

  it("keeps distinct links received while the cold-start snapshot is pending", async () => {
    let receive!: (urls: string[]) => void;
    let resolveCurrent!: (urls: string[] | null) => void;
    onOpenUrlMock.mockImplementation(async handler => { receive = handler; return vi.fn<() => void>(); });
    getCurrentMock.mockImplementation(() => new Promise(resolve => { resolveCurrent = resolve; }));
    const received: string[] = [];
    const starting = startDeepLinkListener({
      onRepoAdd: url => { received.push(url); },
      onTaskNotificationAction: action => { received.push(action.type); },
    });
    await vi.waitFor(() => expect(getCurrentMock).toHaveBeenCalledOnce());

    receive(["norea://tasks"]);
    resolveCurrent(["norea://repo/add?url=https%3A%2F%2Fexample.test%2Fplugins.json"]);
    const cleanup = await starting;

    expect(received).toEqual(["https://example.test/plugins.json", "openTasks"]);
    cleanup();
  });

  it("delivers repeated running-app taps and stops delivering after cleanup", async () => {
    let receive!: (urls: string[]) => void;
    onOpenUrlMock.mockImplementation(async handler => { receive = handler; return vi.fn<() => void>(); });
    const onAction = vi.fn();
    const cleanup = await startDeepLinkListener({ onRepoAdd: vi.fn(), onTaskNotificationAction: onAction });

    receive(["norea://tasks"]);
    receive(["norea://tasks"]);
    expect(onAction).toHaveBeenCalledTimes(2);
    cleanup();
    receive(["norea://tasks"]);
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("releases the native listener if the cold-start read fails", async () => {
    const unlisten = vi.fn();
    onOpenUrlMock.mockResolvedValue(unlisten);
    getCurrentMock.mockRejectedValue(new Error("deep-link read failed"));

    await expect(startDeepLinkListener({ onRepoAdd: vi.fn() })).rejects.toThrow("deep-link read failed");
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
