import { expect, it } from "vitest";
import type { StoredChapterDownloadFailure } from "../../db/queries/chapter-download-failure";
import { chapterDownloadFailureAttention } from "./chapter-download-failure-attention";

function row(chapterId: number, patch: Partial<StoredChapterDownloadFailure> = {}): StoredChapterDownloadFailure {
  return {
    chapterId, pluginId: "source", failureClass: "content", messageSummary: `Error ${chapterId}`, challengeUrl: null,
    attempts: 1, nextRetryAt: null, jobJson: JSON.stringify({ id: chapterId }), updatedAt: chapterId, ...patch,
  };
}

it("groups failures by source and class with one action each and counts waiting retries as information", () => {
  const attention = chapterDownloadFailureAttention([
    row(1), row(2), row(3, { pluginId: "other" }),
    row(4, { failureClass: "transient", attempts: 4 }),
    row(5, { failureClass: "transient", nextRetryAt: 99 }), row(6, { failureClass: "transient", nextRetryAt: 120 }),
    row(7, { failureClass: "media-incomplete" }),
    row(8, { failureClass: "challenge", challengeUrl: "https://cdn.example/" }),
    row(9, { failureClass: "challenge", challengeUrl: "https://cdn.example/" }),
    row(10, { failureClass: "challenge", challengeUrl: "https://source.example/chapter" }),
    row(11, { failureClass: "storage" }),
  ]);
  expect(attention.retrying).toBe(2);
  expect(attention.groups.map((group) => [group.pluginId, group.failureClass, group.action, group.chapterIds, group.challengeHost]))
    .toEqual([
      ["source", "content", "retry", [1, 2], ""],
      ["other", "content", "retry", [3], ""],
      ["source", "transient", "retry", [4], ""],
      ["source", "media-incomplete", "repair", [7], ""],
      ["source", "challenge", "verify", [8, 9], "cdn.example"],
      ["source", "challenge", "verify", [10], "source.example"],
      ["source", "storage", "retry", [11], ""],
    ]);
  expect(attention.groups[0]?.latestSummary).toBe("Error 2");
});

it("collects the VPN ranges whose paused chapters belong to a group", () => {
  const vpn = (chapterId: number, rangeId: string) =>
    row(chapterId, { jobJson: JSON.stringify({ id: chapterId, vpnPlanId: "plan", vpnRangeId: rangeId }) });
  const [group] = chapterDownloadFailureAttention([vpn(1, "a"), vpn(2, "a"), vpn(3, "b"), row(4)]).groups;
  expect(group?.chapterIds).toEqual([1, 2, 3, 4]);
  expect(group?.vpnRanges).toEqual([{ planId: "plan", rangeId: "a" }, { planId: "plan", rangeId: "b" }]);
});
