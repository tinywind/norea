import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import type {
  VpnDownloadPlan,
  VpnDownloadRangeState,
} from "../../lib/tasks/vpn-download-types";
import { createTauriInvokeRouter } from "../../test/mock-tauri-invoke";
import {
  cancelVpnDownloadPlan,
  cancelVpnDownloadRange,
  createVpnDownloadPlan,
  getVpnDownloadRangeJobs,
  listVpnDownloadPlans,
  parseStoredChapterDownloadJob,
  readVpnDownloadPlan,
  settleVpnDownloadChapter,
  updateVpnDownloadPlan,
} from "./vpn-download-plans";

const invokeMock = vi.mocked(invoke);
const router = createTauriInvokeRouter();

beforeEach(() => {
  vi.clearAllMocks();
  router.reset();
  router.installOn(invokeMock);
});

function range(
  id: string,
  profileId: string,
  chapterIds: number[],
  selectedChapterIds: number[],
): VpnDownloadRangeState {
  return {
    id,
    profileId,
    profileHash: "a".repeat(64),
    chapterIds,
    selectedChapterIds,
    startChapterId: chapterIds[0]!,
    endChapterId: chapterIds.at(-1)!,
    checkpoint: 0,
    phase: "paused",
    userPaused: false,
    pauseReason: null,
    attemptedProfileIds: [],
    attemptProfileId: null,
    generation: 2,
    challenge: null,
  };
}

function plan(): VpnDownloadPlan {
  return {
    id: "plan-1",
    batchId: "batch-1",
    pluginId: "source",
    novelId: 42,
    title: "Work",
    mode: "parallel",
    policies: { captcha: "nextProfile", cloudflare: "pause" },
    createdAt: 100,
    revision: 0,
    ranges: [
      range("lane-a", "profile-a", [31, 7, 22], [31, 22]),
      range("lane-b", "profile-b", [4, 19, 12], [4, 12]),
    ],
  };
}

function jobs(value = plan()): ChapterDownloadJob[] {
  return value.ranges.flatMap((item) =>
    item.selectedChapterIds.slice(item.checkpoint).map((id) => ({
      id,
      pluginId: value.pluginId,
      novelId: value.novelId,
      novelPath: value.novelId === 42 ? "/work" : "/other",
      chapterPath: `/${id}`,
      title: `Chapter ${id}`,
      batchId: value.batchId,
      vpnPlanId: value.id,
      vpnRangeId: item.id,
    })),
  );
}

describe("VPN download plan IPC commands", () => {
  it("validates and sends plan and jobs to db_vpn_plan_create", async () => {
    router.mockMutation("db_vpn_plan_create");
    const value = plan();
    const reversed = jobs(value).reverse();

    await createVpnDownloadPlan(value, reversed);

    expect(router.calls).toEqual([
      {
        command: "db_vpn_plan_create",
        args: { plan: value, jobs: reversed },
        options: undefined,
      },
    ]);
  });

  it("reads and lists plans and range jobs via db_vpn_plan_* queries", async () => {
    const value = plan();
    const laneJobs = jobs(value).filter((job) => job.vpnRangeId === "lane-a");
    router.mockQuery("db_vpn_plan_read", (args) =>
      (args as { id: string }).id === "plan-1" ? value : null,
    );
    router.mockQuery("db_vpn_plan_list", [value]);
    router.mockQuery("db_vpn_plan_get_range_jobs", laneJobs);

    await expect(readVpnDownloadPlan("plan-1")).resolves.toEqual(value);
    await expect(readVpnDownloadPlan("missing")).resolves.toBeUndefined();
    await expect(listVpnDownloadPlans()).resolves.toEqual([value]);
    await expect(getVpnDownloadRangeJobs("plan-1", "lane-a")).resolves.toEqual(
      laneJobs,
    );

    expect(router.calls.map((call) => [call.command, call.args])).toEqual([
      ["db_vpn_plan_read", { id: "plan-1" }],
      ["db_vpn_plan_read", { id: "missing" }],
      ["db_vpn_plan_list", undefined],
      [
        "db_vpn_plan_get_range_jobs",
        { planId: "plan-1", rangeId: "lane-a" },
      ],
    ]);
  });

  it("delegates CAS updates, pass restarts, settlements, and cancellations to Rust", async () => {
    const base = plan();
    const updated: VpnDownloadPlan = { ...base, revision: 1 };
    const settled: VpnDownloadPlan = { ...base, revision: 2 };
    const cancelled: VpnDownloadPlan = { ...base, revision: 3 };

    router.mockMutation("db_vpn_plan_update", updated);
    router.mockMutation("db_vpn_plan_settle_chapter", settled);
    router.mockMutation("db_vpn_plan_cancel_range", cancelled);
    router.mockMutation("db_vpn_plan_cancel");

    await expect(updateVpnDownloadPlan(base, 0)).resolves.toEqual(updated);
    await expect(
      updateVpnDownloadPlan(base, 1, { restartPassRangeId: "lane-a" }),
    ).resolves.toEqual(updated);
    await expect(
      settleVpnDownloadChapter("plan-1", "lane-a", 31, 2),
    ).resolves.toEqual(settled);
    await expect(cancelVpnDownloadRange("plan-1", "lane-a")).resolves.toEqual(
      cancelled,
    );
    await cancelVpnDownloadPlan("plan-1");

    expect(router.calls).toEqual([
      {
        command: "db_vpn_plan_update",
        args: {
          plan: base,
          expectedRevision: 0,
          restartPassRangeId: null,
        },
        options: undefined,
      },
      {
        command: "db_vpn_plan_update",
        args: {
          plan: base,
          expectedRevision: 1,
          restartPassRangeId: "lane-a",
        },
        options: undefined,
      },
      {
        command: "db_vpn_plan_settle_chapter",
        args: {
          planId: "plan-1",
          rangeId: "lane-a",
          chapterId: 31,
          expectedGeneration: 2,
        },
        options: undefined,
      },
      {
        command: "db_vpn_plan_cancel_range",
        args: { planId: "plan-1", rangeId: "lane-a" },
        options: undefined,
      },
      {
        command: "db_vpn_plan_cancel",
        args: { planId: "plan-1" },
        options: undefined,
      },
    ]);
  });
});

describe("client-side contract validation before IPC", () => {
  it("requires revision zero on create and a valid range ID on explicit pass restart", async () => {
    const nonZero = { ...plan(), revision: 1 };
    await expect(
      createVpnDownloadPlan(nonZero, jobs(nonZero)),
    ).rejects.toThrow(/revision zero/i);
    await expect(
      updateVpnDownloadPlan(plan(), 0, { restartPassRangeId: "   " }),
    ).rejects.toThrow(/range ID/i);
    expect(router.calls).toHaveLength(0);
  });

  it("rejects jobs from another batch before IPC", async () => {
    const value = plan();
    const wrong = jobs(value).map((job) => ({ ...job, batchId: "other-batch" }));
    await expect(createVpnDownloadPlan(value, wrong)).rejects.toThrow(/batch/i);
    expect(router.calls).toHaveLength(0);
  });

  it.each([
    [null],
    [[]],
    [{ "": 2 }],
    [{ "profile-a": -1 }],
    [{ "profile-a": 1.5 }],
    [{ "profile-a": "2" }],
  ])("rejects malformed consumed reallow revisions: %s", async (revisions) => {
    const value = plan();
    Object.assign(value.ranges[0]!, { consumedReallowRevisions: revisions });
    await expect(createVpnDownloadPlan(value, jobs(value))).rejects.toThrow(
      /reallow|revision|range/i,
    );
    expect(router.calls).toHaveLength(0);
  });

  it.each([
    ["empty identity", (value: VpnDownloadPlan) => { value.id = ""; }],
    ["empty selection", (value: VpnDownloadPlan) => { for (const item of value.ranges) item.selectedChapterIds = []; }],
    ["checkpoint bounds", (value: VpnDownloadPlan) => { value.ranges[0]!.checkpoint = 3; }],
    ["overlap", (value: VpnDownloadPlan) => { value.ranges[1]!.chapterIds.unshift(22); value.ranges[1]!.startChapterId = 22; }],
    ["reversed selected order", (value: VpnDownloadPlan) => { value.ranges[0]!.selectedChapterIds.reverse(); }],
    ["duplicate range", (value: VpnDownloadPlan) => { value.ranges[1]!.id = "lane-a"; }],
    ["profile hash without profile", (value: VpnDownloadPlan) => { value.ranges[1]!.profileId = null; }],
    ["profile without hash", (value: VpnDownloadPlan) => { value.ranges[1]!.profileHash = null; }],
    ["non-string policy", (value: VpnDownloadPlan) => { value.policies.captcha = ["pause"] as never; }],
    ["non-string phase", (value: VpnDownloadPlan) => { value.ranges[0]!.phase = ["paused"] as never; }],
    ["credentialed challenge url", (value: VpnDownloadPlan) => { value.ranges[0]!.challenge = { kind: "captcha", url: "https://user:pass@source.test/work" }; }],
  ] as const)("rejects invalid plan %s before IPC", async (_label, mutate) => {
    const value = plan();
    mutate(value);
    await expect(createVpnDownloadPlan(value, jobs(value))).rejects.toThrow();
    expect(router.calls).toHaveLength(0);
  });

  it.each([
    ["missing chapter", (value: ChapterDownloadJob[]) => { value.pop(); }],
    ["duplicate chapter", (value: ChapterDownloadJob[]) => { value.push(value[0]!); }],
    ["wrong range", (value: ChapterDownloadJob[]) => { value[0]!.vpnRangeId = "lane-b"; }],
    ["wrong plan", (value: ChapterDownloadJob[]) => { value[0]!.vpnPlanId = "other-plan"; }],
    ["wrong source", (value: ChapterDownloadJob[]) => { value[0]!.pluginId = "other-source"; }],
    ["wrong work", (value: ChapterDownloadJob[]) => { value[0]!.novelId = 99; }],
    ["invalid title payload", (value: ChapterDownloadJob[]) => { value[0]!.title = 123 as never; }],
    ["non-string priority", (value: ChapterDownloadJob[]) => { value[0]!.priority = ["user"] as never; }],
    ["non-string content type", (value: ChapterDownloadJob[]) => { value[0]!.contentType = ["html"] as never; }],
  ] as const)("rejects invalid job %s before IPC", async (_label, mutate) => {
    const value = jobs();
    mutate(value);
    await expect(createVpnDownloadPlan(plan(), value)).rejects.toThrow();
    expect(router.calls).toHaveLength(0);
  });

  it("validates stored chapter download jobs via parseStoredChapterDownloadJob", () => {
    const valid = jobs()[0]!;
    expect(
      parseStoredChapterDownloadJob({
        chapterId: valid.id,
        jobJson: JSON.stringify(valid),
      }),
    ).toEqual(valid);

    expect(() =>
      parseStoredChapterDownloadJob({
        chapterId: 999,
        jobJson: JSON.stringify(valid),
      }),
    ).toThrow(/identity differs/i);
  });
});
